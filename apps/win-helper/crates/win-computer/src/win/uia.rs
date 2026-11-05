//! UI Automation: the live [`TreeSource`] and the element operations behind `computer.*` (the
//! Windows side of the mac helper's `LiveAX.swift` / `AXEngine.swift`).
//!
//! Performance: one cache request fetches an element's children *and* every property the
//! builder reads (name, control type, ids, bounds, pattern availability and pattern state) in a
//! single cross-process call per parent (`BuildUpdatedCache` with `TreeScope_Children` and the
//! ControlView filter), so a snapshot costs about one round trip per container instead of one per
//! property. Element identity is the UIA runtime id: stable for the element's lifetime, so a ref
//! keeps naming the same element across snapshots.
//!
//! Everything here runs on a [`super::com`] pool worker (MTA).

use super::apps::{self, TargetApp};
use super::com::Agile;
use crate::error::{code, CapError, CapResult};
use crate::roles::{self, ct, UiaFacts};
use crate::snapshot::{text, ElementInfo, Rect, TreeSource};
use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;
use windows::core::{Interface, BSTR, HRESULT};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, SAFEARRAY};
use windows::Win32::System::Ole::{SafeArrayAccessData, SafeArrayGetLBound, SafeArrayGetUBound, SafeArrayUnaccessData};
use windows::Win32::System::Variant::*;
use windows::Win32::UI::Accessibility::*;

// MARK: - Per-thread automation context

pub struct Uia {
    pub auto: IUIAutomation,
    /// Element + control-view children, all properties.
    pub req_children: IUIAutomationCacheRequest,
    /// The element alone, all properties.
    pub req_element: IUIAutomationCacheRequest,
    pub walker: IUIAutomationTreeWalker,
}

thread_local! {
    static UIA: RefCell<Option<Rc<Uia>>> = const { RefCell::new(None) };
}

const PROPS: &[UIA_PROPERTY_ID] = &[
    UIA_RuntimeIdPropertyId,
    UIA_NamePropertyId,
    UIA_ControlTypePropertyId,
    UIA_AutomationIdPropertyId,
    UIA_ClassNamePropertyId,
    UIA_FrameworkIdPropertyId,
    UIA_HelpTextPropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsPasswordPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_BoundingRectanglePropertyId,
    UIA_ProcessIdPropertyId,
    UIA_NativeWindowHandlePropertyId,
    UIA_IsDialogPropertyId,
    UIA_HeadingLevelPropertyId,
    UIA_LabeledByPropertyId,
    UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsTogglePatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId,
    UIA_IsRangeValuePatternAvailablePropertyId,
    UIA_IsWindowPatternAvailablePropertyId,
    UIA_IsTextPatternAvailablePropertyId,
    UIA_IsLegacyIAccessiblePatternAvailablePropertyId,
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_RangeValueValuePropertyId,
    UIA_RangeValueIsReadOnlyPropertyId,
    UIA_LegacyIAccessibleDefaultActionPropertyId,
];

/// UIA connection timeout (mac `AXEngine.messagingTimeout`) and per-call transaction timeout.
pub const CONNECTION_TIMEOUT_MS: u32 = 1000;
pub const TRANSACTION_TIMEOUT_MS: u32 = 3000;

fn make_request(auto: &IUIAutomation, children: bool) -> windows::core::Result<IUIAutomationCacheRequest> {
    unsafe {
        let r = auto.CreateCacheRequest()?;
        for p in PROPS {
            let _ = r.AddProperty(*p);
        }
        r.SetTreeScope(if children { TreeScope(TreeScope_Element.0 | TreeScope_Children.0) } else { TreeScope_Element })?;
        r.SetTreeFilter(&auto.ControlViewCondition()?)?;
        Ok(r)
    }
}

/// This worker thread's automation context.
pub fn uia() -> CapResult<Rc<Uia>> {
    UIA.with(|slot| {
        if let Some(u) = slot.borrow().as_ref() {
            return Ok(u.clone());
        }
        let u = (|| -> windows::core::Result<Uia> {
            unsafe {
                let auto: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
                if let Ok(a2) = auto.cast::<IUIAutomation2>() {
                    let _ = a2.SetConnectionTimeout(CONNECTION_TIMEOUT_MS);
                    let _ = a2.SetTransactionTimeout(TRANSACTION_TIMEOUT_MS);
                }
                Ok(Uia {
                    req_children: make_request(&auto, true)?,
                    req_element: make_request(&auto, false)?,
                    walker: auto.ControlViewWalker()?,
                    auto,
                })
            }
        })()
        .map_err(|e| CapError::unavailable("uia_unavailable", format!("UI Automation is unavailable (0x{:08x})", e.code().0)))?;
        let u = Rc::new(u);
        *slot.borrow_mut() = Some(u.clone());
        Ok(u)
    })
}

// MARK: - HRESULTs

pub const E_ELEMENT_NOT_AVAILABLE: u32 = UIA_E_ELEMENTNOTAVAILABLE;
pub const E_TIMEOUT: u32 = UIA_E_TIMEOUT;
const E_ACCESSDENIED: u32 = 0x8007_0005;
const CO_E_OBJNOTCONNECTED: u32 = 0x8004_01FD;
const RPC_E_DISCONNECTED: u32 = 0x8001_0108;
const RPC_S_SERVER_UNAVAILABLE: u32 = 0x8007_06BA;
const RPC_S_CALL_FAILED: u32 = 0x8007_06BE;

pub fn hr(e: &windows::core::Error) -> u32 {
    e.code().0 as u32
}

pub fn is_gone(h: u32) -> bool {
    matches!(h, E_ELEMENT_NOT_AVAILABLE | CO_E_OBJNOTCONNECTED | RPC_E_DISCONNECTED | RPC_S_SERVER_UNAVAILABLE | RPC_S_CALL_FAILED)
}

pub fn stale(r: &str) -> CapError {
    CapError::new(code::NOT_FOUND, "stale_ref", format!("{r} no longer exists. Take a new snapshot.")).detail("ref", r)
}

pub fn not_responding(app_name: &str) -> CapError {
    CapError::new(code::UNAVAILABLE, "app_not_responding", format!("{app_name} is not responding")).retryable()
}

/// Maps a UIA failure while reading `r`.
pub fn map_read_error(e: &windows::core::Error, r: &str, app_name: &str) -> CapError {
    match hr(e) {
        E_TIMEOUT => not_responding(app_name),
        E_ACCESSDENIED => CapError::new(
            code::FORBIDDEN,
            "target_elevated",
            format!("{app_name} runs with higher privileges; Windows does not let Psyche read it"),
        ),
        _ => stale(r),
    }
}

// MARK: - VARIANT decoding

struct Var(VARIANT);
impl Drop for Var {
    fn drop(&mut self) {
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

impl Var {
    fn vt(&self) -> VARENUM {
        unsafe { self.0.Anonymous.Anonymous.vt }
    }
    fn string(&self) -> Option<String> {
        if self.vt() != VT_BSTR {
            return None;
        }
        unsafe { Some(self.0.Anonymous.Anonymous.Anonymous.bstrVal.to_string()) }
    }
    fn boolean(&self) -> Option<bool> {
        if self.vt() != VT_BOOL {
            return None;
        }
        unsafe { Some(self.0.Anonymous.Anonymous.Anonymous.boolVal.0 != 0) }
    }
    fn int(&self) -> Option<i32> {
        unsafe {
            match self.vt() {
                VT_I4 | VT_INT => Some(self.0.Anonymous.Anonymous.Anonymous.lVal),
                VT_I2 => Some(self.0.Anonymous.Anonymous.Anonymous.iVal as i32),
                VT_UI4 | VT_UINT => Some(self.0.Anonymous.Anonymous.Anonymous.ulVal as i32),
                _ => None,
            }
        }
    }
    fn float(&self) -> Option<f64> {
        unsafe {
            match self.vt() {
                VT_R8 => Some(self.0.Anonymous.Anonymous.Anonymous.dblVal),
                VT_R4 => Some(self.0.Anonymous.Anonymous.Anonymous.fltVal as f64),
                _ => self.int().map(|i| i as f64),
            }
        }
    }
    fn int_array(&self) -> Option<Vec<i32>> {
        if self.vt().0 != (VT_ARRAY.0 | VT_I4.0) {
            return None;
        }
        unsafe { safearray_i32(self.0.Anonymous.Anonymous.Anonymous.parray) }
    }
}

unsafe fn safearray_i32(sa: *mut SAFEARRAY) -> Option<Vec<i32>> {
    if sa.is_null() {
        return None;
    }
    let lo = SafeArrayGetLBound(sa, 1).ok()?;
    let hi = SafeArrayGetUBound(sa, 1).ok()?;
    let n = (hi - lo + 1).max(0) as usize;
    let mut data: *mut std::ffi::c_void = std::ptr::null_mut();
    SafeArrayAccessData(sa, &mut data).ok()?;
    let v = std::slice::from_raw_parts(data as *const i32, n).to_vec();
    let _ = SafeArrayUnaccessData(sa);
    Some(v)
}

fn cached(e: &IUIAutomationElement, p: UIA_PROPERTY_ID) -> Option<Var> {
    unsafe { e.GetCachedPropertyValueEx(p, true).ok().map(Var) }
}

fn cached_str(e: &IUIAutomationElement, p: UIA_PROPERTY_ID) -> Option<String> {
    cached(e, p).and_then(|v| v.string())
}
fn cached_bool(e: &IUIAutomationElement, p: UIA_PROPERTY_ID) -> bool {
    cached(e, p).and_then(|v| v.boolean()).unwrap_or(false)
}
fn cached_int(e: &IUIAutomationElement, p: UIA_PROPERTY_ID) -> Option<i32> {
    cached(e, p).and_then(|v| v.int())
}

/// Runtime id of an element with a cache (falls back to the live call).
fn runtime_id(e: &IUIAutomationElement) -> Vec<i32> {
    if let Some(v) = cached(e, UIA_RuntimeIdPropertyId).and_then(|v| v.int_array()) {
        if !v.is_empty() {
            return v;
        }
    }
    unsafe {
        if let Ok(sa) = e.GetRuntimeId() {
            let v = safearray_i32(sa);
            let _ = windows::Win32::System::Ole::SafeArrayDestroy(sa);
            if let Some(v) = v.filter(|v| !v.is_empty()) {
                return v;
            }
        }
    }
    vec![-1, e.as_raw() as usize as i32]
}

// MARK: - Nodes

/// One UIA element, keyed by runtime id.
#[derive(Clone)]
pub struct El {
    pub key: Arc<Vec<i32>>,
    pub e: Agile<IUIAutomationElement>,
    /// Control type of the parent it was reached through (menu bar items, title-bar buttons).
    pub parent_ct: Option<i32>,
    /// The snapshot root, a top-level window.
    pub top_level: bool,
    /// The app the snapshot that found it was for.
    pub app_pid: u32,
    pub root_hwnd: isize,
}

/// A tree node: a UIA element, or the synthetic application root (`root: "app"`), whose
/// children are the app's top-level windows (the mac `AXApplication`).
#[derive(Clone)]
pub enum Node {
    App { pid: u32, name: String, windows: Vec<isize> },
    El(El),
}

impl PartialEq for Node {
    fn eq(&self, o: &Node) -> bool {
        match (self, o) {
            (Node::App { pid: a, .. }, Node::App { pid: b, .. }) => a == b,
            (Node::El(a), Node::El(b)) => a.key == b.key,
            _ => false,
        }
    }
}
impl Eq for Node {}
impl Hash for Node {
    fn hash<H: Hasher>(&self, h: &mut H) {
        match self {
            Node::App { pid, .. } => (0u8, *pid).hash(h),
            Node::El(e) => (1u8, e.key.as_slice()).hash(h),
        }
    }
}

impl Node {
    pub fn el(&self) -> Option<&El> {
        match self {
            Node::El(e) => Some(e),
            _ => None,
        }
    }
}

pub fn node_for(e: IUIAutomationElement, parent_ct: Option<i32>, top_level: bool, app_pid: u32, root_hwnd: isize) -> Node {
    Node::El(El { key: Arc::new(runtime_id(&e)), e: Agile(e), parent_ct, top_level, app_pid, root_hwnd })
}

/// What one element looks like to the builder.
#[derive(Clone)]
pub struct Computed {
    pub info: ElementInfo,
    pub facts: UiaFacts,
    pub pid: u32,
    pub hwnd: isize,
    pub offscreen: bool,
}

fn rect_of_cached(e: &IUIAutomationElement) -> Option<Rect> {
    unsafe { e.CachedBoundingRectangle().ok().map(apps::rect_of) }
}

/// Text of a document without a Value pattern (TextPattern), capped.
fn document_text(e: &IUIAutomationElement, max: i32) -> Option<String> {
    unsafe {
        let tp: IUIAutomationTextPattern = e.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
        let s = tp.DocumentRange().ok()?.GetText(max).ok()?.to_string();
        Some(s)
    }
}

fn is_win32_multiline(hwnd: isize, class: &str) -> bool {
    if hwnd == 0 || !(class.eq_ignore_ascii_case("Edit") || class.to_ascii_lowercase().starts_with("richedit")) {
        return false;
    }
    let style = unsafe {
        windows::Win32::UI::WindowsAndMessaging::GetWindowLongW(apps::hwnd(hwnd), windows::Win32::UI::WindowsAndMessaging::GWL_STYLE)
    };
    style as u32 & 0x0004 != 0 // ES_MULTILINE
}

/// Reads the cached properties of `n` (no cross-process call, except a document's text or a
/// label element's name when the builder needs them).
pub fn compute(n: &Node, live_text: bool) -> Option<Computed> {
    let el = match n {
        Node::App { pid, name, .. } => {
            let mut info = ElementInfo::new("AXApplication");
            info.title = Some(name.clone());
            return Some(Computed { info, facts: UiaFacts::default(), pid: *pid, hwnd: 0, offscreen: false });
        }
        Node::El(el) => el,
    };
    let e = &el.e.0;
    let control_type = cached_int(e, UIA_ControlTypePropertyId)?;
    let class_name = cached_str(e, UIA_ClassNamePropertyId).unwrap_or_default();
    let hwnd = cached_int(e, UIA_NativeWindowHandlePropertyId).unwrap_or(0) as isize;
    let legacy = cached_str(e, UIA_LegacyIAccessibleDefaultActionPropertyId).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let facts = UiaFacts {
        control_type,
        parent_control_type: el.parent_ct,
        automation_id: cached_str(e, UIA_AutomationIdPropertyId).unwrap_or_default(),
        multiline: control_type == ct::EDIT && is_win32_multiline(hwnd, &class_name),
        class_name,
        framework_id: cached_str(e, UIA_FrameworkIdPropertyId).unwrap_or_default(),
        is_password: cached_bool(e, UIA_IsPasswordPropertyId),
        is_dialog: cached_bool(e, UIA_IsDialogPropertyId),
        heading: cached_int(e, UIA_HeadingLevelPropertyId).map(|h| h != HeadingLevel_None.0 && h != 0).unwrap_or(false),
        top_level: el.top_level,
        invoke: cached_bool(e, UIA_IsInvokePatternAvailablePropertyId),
        toggle: cached_bool(e, UIA_IsTogglePatternAvailablePropertyId),
        selection_item: cached_bool(e, UIA_IsSelectionItemPatternAvailablePropertyId),
        expand_collapse: cached_bool(e, UIA_IsExpandCollapsePatternAvailablePropertyId),
        value: cached_bool(e, UIA_IsValuePatternAvailablePropertyId),
        value_read_only: cached_bool(e, UIA_ValueIsReadOnlyPropertyId),
        range_value: cached_bool(e, UIA_IsRangeValuePatternAvailablePropertyId),
        range_read_only: cached_bool(e, UIA_RangeValueIsReadOnlyPropertyId),
        window: cached_bool(e, UIA_IsWindowPatternAvailablePropertyId),
        legacy_default_action: legacy && cached_bool(e, UIA_IsLegacyIAccessiblePatternAvailablePropertyId),
    };
    let mapped = roles::map_role(&facts);
    let role = mapped.role;
    let name = cached_str(e, UIA_NamePropertyId).filter(|s| !s.is_empty());
    let help = cached_str(e, UIA_HelpTextPropertyId).filter(|s| !s.is_empty());
    let secure = mapped.subrole == Some("AXSecureTextField");
    let mut info = ElementInfo::new(role);
    info.subrole = mapped.subrole.map(str::to_string);
    info.identifier = text::non_empty(Some(&facts.automation_id));
    info.enabled = Some(cached_bool(e, UIA_IsEnabledPropertyId));
    info.frame = rect_of_cached(e);
    let text_input = crate::snapshot::roles::is(crate::snapshot::roles::TEXT_INPUTS, role);
    if mapped.name_is_value {
        info.value = name;
    } else if !mapped.drop_name {
        if role == "AXImage" {
            info.description = name.or(help.clone());
        } else {
            info.title = name;
        }
    }
    if text_input {
        info.placeholder = help;
    } else if role != "AXImage" && info.description.is_none() && !mapped.name_is_value {
        info.description = help;
    }
    if !mapped.name_is_value {
        let raw_value = || cached_str(e, UIA_ValueValuePropertyId);
        info.value = if secure {
            // Never read: a secure field shows as "•••" whatever it holds.
            Some("•••".into())
        } else if role == "AXCheckBox" && facts.toggle {
            cached_int(e, UIA_ToggleToggleStatePropertyId).map(|s| s.to_string())
        } else if role == "AXRadioButton" && facts.selection_item {
            Some(if cached_bool(e, UIA_SelectionItemIsSelectedPropertyId) { "1" } else { "0" }.into())
        } else if role == "AXWebArea" || role == "AXLink" {
            info.url = raw_value().filter(|u| u.contains(':'));
            None
        } else if facts.value {
            raw_value()
        } else if facts.range_value && matches!(role, "AXSlider" | "AXIncrementor" | "AXProgressIndicator") {
            cached(e, UIA_RangeValueValuePropertyId).and_then(|v| v.float()).map(roles::number_string)
        } else if role == "AXTextArea" && live_text && cached_bool(e, UIA_IsTextPatternAvailablePropertyId) {
            document_text(e, 100_000)
        } else {
            None
        };
    }
    if matches!(role, "AXRow" | "AXCell") && facts.selection_item {
        info.selected = Some(cached_bool(e, UIA_SelectionItemIsSelectedPropertyId));
    }
    if info.title.is_none() && (text_input || matches!(role, "AXSlider" | "AXPopUpButton" | "AXCheckBox")) {
        if let Ok(lab) = unsafe { e.CachedLabeledBy() } {
            info.title_element_value = unsafe { lab.CurrentName() }.ok().map(|s| s.to_string()).filter(|s| !s.is_empty());
        }
    }
    Some(Computed {
        info,
        pid: cached_int(e, UIA_ProcessIdPropertyId).unwrap_or(0) as u32,
        hwnd,
        offscreen: cached_bool(e, UIA_IsOffscreenPropertyId),
        facts,
    })
}

/// Refreshes an element's cache (one call). `Err` with the HRESULT when it is gone or hung.
pub fn refresh(u: &Uia, el: &El) -> windows::core::Result<El> {
    let fresh = unsafe { el.e.0.BuildUpdatedCache(&u.req_element)? };
    Ok(El { e: Agile(fresh), ..el.clone() })
}

pub fn element_for_window(u: &Uia, hwnd: isize, app_pid: u32) -> windows::core::Result<Node> {
    let e = unsafe { u.auto.ElementFromHandleBuildCache(apps::hwnd(hwnd), &u.req_element)? };
    Ok(node_for(e, None, true, app_pid, hwnd))
}

// MARK: - Live source

pub struct LiveSource<'a> {
    pub u: &'a Uia,
    pub deadline: Option<Instant>,
    pub clip: bool,
    cache: RefCell<HashMap<Node, Option<Rc<Computed>>>>,
}

impl<'a> LiveSource<'a> {
    pub fn new(u: &'a Uia, deadline: Option<Instant>, clip: bool) -> Self {
        LiveSource { u, deadline, clip, cache: RefCell::new(HashMap::new()) }
    }

    pub fn computed(&self, n: &Node) -> Option<Rc<Computed>> {
        if let Some(c) = self.cache.borrow().get(n) {
            return c.clone();
        }
        let mut c = compute(n, true);
        if let Some(c) = c.as_mut() {
            // A hidden container (no bounds, offscreen) is walked but never labelled, so its
            // visible children hoist (title bars report no bounds of their own).
            if self.clip && c.offscreen && c.info.frame.map(|r| r.w <= 0.0 || r.h <= 0.0).unwrap_or(true) {
                c.info.title = None;
                c.info.description = None;
                c.info.frame = None;
            }
        }
        let c = c.map(Rc::new);
        self.cache.borrow_mut().insert(n.clone(), c.clone());
        c
    }
}

/// Control types that hold other elements: never skipped for having no bounds of their own.
fn is_container(control_type: i32) -> bool {
    matches!(
        control_type,
        ct::PANE
            | ct::GROUP
            | ct::CUSTOM
            | ct::TITLE_BAR
            | ct::TOOL_BAR
            | ct::APP_BAR
            | ct::STATUS_BAR
            | ct::TAB
            | ct::LIST
            | ct::TREE
            | ct::DATA_GRID
            | ct::TABLE
            | ct::DOCUMENT
            | ct::MENU
            | ct::MENU_BAR
            | ct::HEADER
            | ct::SEMANTIC_ZOOM
    )
}

impl TreeSource for LiveSource<'_> {
    type Element = Node;

    fn info(&self, n: &Node) -> Option<ElementInfo> {
        self.computed(n).map(|c| c.info.clone())
    }

    fn children(&self, n: &Node) -> Vec<Node> {
        match n {
            Node::App { pid, windows, .. } => windows.iter().filter_map(|h| element_for_window(self.u, *h, *pid).ok()).collect(),
            Node::El(el) => {
                let my_ct = self.computed(n).map(|c| c.facts.control_type);
                let Ok(fresh) = (unsafe { el.e.0.BuildUpdatedCache(&self.u.req_children) }) else { return Vec::new() };
                let Ok(arr) = (unsafe { fresh.GetCachedChildren() }) else { return Vec::new() };
                let len = unsafe { arr.Length() }.unwrap_or(0);
                let mut out = Vec::with_capacity(len.max(0) as usize);
                for i in 0..len {
                    let Ok(c) = (unsafe { arr.GetElement(i) }) else { continue };
                    // The title bar's system menu is window chrome, not app content.
                    if cached_str(&c, UIA_AutomationIdPropertyId).as_deref() == Some("SystemMenuBar") {
                        continue;
                    }
                    // Virtualized / scrolled-away / hidden controls report no bounds: like the
                    // Mac's off-window elements, they are clipped (menus excepted). Containers
                    // are still walked: a title bar has no bounds but visible buttons.
                    if self.clip && cached_bool(&c, UIA_IsOffscreenPropertyId) {
                        let empty = rect_of_cached(&c).map(|r| r.w <= 0.0 || r.h <= 0.0).unwrap_or(true);
                        let kind = cached_int(&c, UIA_ControlTypePropertyId).unwrap_or(0);
                        let menu = matches!(kind, ct::MENU | ct::MENU_ITEM | ct::MENU_BAR);
                        if empty && !menu && !is_container(kind) {
                            continue;
                        }
                    }
                    out.push(node_for(c, my_ct, false, el.app_pid, el.root_hwnd));
                }
                out
            }
        }
    }

    fn actions(&self, n: &Node) -> Vec<String> {
        self.computed(n).map(|c| roles::actions(&c.facts, &c.info.role)).unwrap_or_default()
    }

    fn is_value_settable(&self, n: &Node) -> bool {
        self.computed(n).map(|c| roles::value_settable(&c.facts)).unwrap_or(false)
    }

    fn should_stop(&self) -> bool {
        self.deadline.map(|d| Instant::now() > d).unwrap_or(false)
    }
}

// MARK: - Element operations

/// An element resolved from a ref, re-read just now (mac `ResolvedElement`).
#[derive(Clone)]
pub struct Resolved {
    pub node: Node,
    pub ref_: String,
    pub app: TargetApp,
    pub info: ElementInfo,
    pub facts: UiaFacts,
    pub role_name: String,
    pub label: Option<String>,
    pub root_hwnd: isize,
}

impl Resolved {
    pub fn elem(&self) -> CapResult<&IUIAutomationElement> {
        self.node
            .el()
            .map(|e| &e.e.0)
            .ok_or_else(|| CapError::new(code::CONFLICT, "not_an_element", format!("{} is the application, not an element", self.ref_)))
    }
}

/// Failure of a pattern call, for `ineffective` outcomes (`detail: "UIA error 0x…"`).
#[derive(Debug)]
pub struct PatternError(pub u32);

impl PatternError {
    pub fn detail(&self) -> String {
        format!("UIA error 0x{:08x}", self.0)
    }
    pub fn not_responding(&self) -> bool {
        self.0 == E_TIMEOUT
    }
}

fn pe(e: windows::core::Error) -> PatternError {
    PatternError(hr(&e))
}

const NOT_SUPPORTED: u32 = 0x8004_0204; // UIA_E_NOTSUPPORTED

fn pattern<T: Interface>(e: &IUIAutomationElement, id: UIA_PATTERN_ID) -> Result<T, PatternError> {
    unsafe { e.GetCurrentPatternAs::<T>(id) }.map_err(pe)
}

/// Performs a raw AX action through the matching UIA pattern.
pub fn perform(r: &Resolved, action: &str) -> Result<(), PatternError> {
    let e = r.elem().map_err(|_| PatternError(NOT_SUPPORTED))?;
    let f = &r.facts;
    let item = matches!(f.control_type, ct::LIST_ITEM | ct::DATA_ITEM | ct::TREE_ITEM);
    unsafe {
        match action {
            "AXPress" => {
                if f.invoke && !item {
                    return pattern::<IUIAutomationInvokePattern>(e, UIA_InvokePatternId)?.Invoke().map_err(pe);
                }
                if f.toggle {
                    return pattern::<IUIAutomationTogglePattern>(e, UIA_TogglePatternId)?.Toggle().map_err(pe);
                }
                if f.selection_item && matches!(f.control_type, ct::RADIO_BUTTON | ct::TAB_ITEM) {
                    return pattern::<IUIAutomationSelectionItemPattern>(e, UIA_SelectionItemPatternId)?.Select().map_err(pe);
                }
                if f.expand_collapse {
                    let p = pattern::<IUIAutomationExpandCollapsePattern>(e, UIA_ExpandCollapsePatternId)?;
                    let st = p.CurrentExpandCollapseState().map_err(pe)?;
                    return if st == ExpandCollapseState_Expanded { p.Collapse() } else { p.Expand() }.map_err(pe);
                }
                if f.legacy_default_action {
                    return pattern::<IUIAutomationLegacyIAccessiblePattern>(e, UIA_LegacyIAccessiblePatternId)?
                        .DoDefaultAction()
                        .map_err(pe);
                }
                Err(PatternError(NOT_SUPPORTED))
            }
            "AXOpen" => {
                if f.invoke {
                    return pattern::<IUIAutomationInvokePattern>(e, UIA_InvokePatternId)?.Invoke().map_err(pe);
                }
                pattern::<IUIAutomationLegacyIAccessiblePattern>(e, UIA_LegacyIAccessiblePatternId)?.DoDefaultAction().map_err(pe)
            }
            "AXShowMenu" => {
                if f.expand_collapse {
                    return pattern::<IUIAutomationExpandCollapsePattern>(e, UIA_ExpandCollapsePatternId)?.Expand().map_err(pe);
                }
                e.cast::<IUIAutomationElement3>().map_err(pe)?.ShowContextMenu().map_err(pe)
            }
            "AXIncrement" | "AXDecrement" => {
                let p = pattern::<IUIAutomationRangeValuePattern>(e, UIA_RangeValuePatternId)?;
                let cur = p.CurrentValue().map_err(pe)?;
                let small = p.CurrentSmallChange().unwrap_or(0.0);
                let step = if small > 0.0 { small } else { p.CurrentLargeChange().ok().filter(|v| *v > 0.0).unwrap_or(1.0) };
                let (lo, hi) = (p.CurrentMinimum().unwrap_or(f64::MIN), p.CurrentMaximum().unwrap_or(f64::MAX));
                let next = if action == "AXIncrement" { cur + step } else { cur - step };
                p.SetValue(next.clamp(lo, hi)).map_err(pe)
            }
            "AXRaise" => {
                let h = if r.root_hwnd != 0 { r.root_hwnd } else { cached_int(e, UIA_NativeWindowHandlePropertyId).unwrap_or(0) as isize };
                if h != 0 {
                    let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(apps::hwnd(h));
                }
                e.SetFocus().map_err(pe)
            }
            _ => Err(PatternError(NOT_SUPPORTED)),
        }
    }
}

/// Writes a text field's value (Value pattern) or a slider's (RangeValue pattern).
pub fn set_value(r: &Resolved, value: &str) -> Result<(), PatternError> {
    let e = r.elem().map_err(|_| PatternError(NOT_SUPPORTED))?;
    unsafe {
        if r.facts.value {
            return pattern::<IUIAutomationValuePattern>(e, UIA_ValuePatternId)?.SetValue(&BSTR::from(value)).map_err(pe);
        }
        if r.facts.range_value {
            let v: f64 = value.trim().parse().map_err(|_| PatternError(0x8007_0057))?; // E_INVALIDARG
            return pattern::<IUIAutomationRangeValuePattern>(e, UIA_RangeValuePatternId)?.SetValue(v).map_err(pe);
        }
    }
    Err(PatternError(NOT_SUPPORTED))
}

pub fn select(r: &Resolved) -> Result<(), PatternError> {
    let e = r.elem().map_err(|_| PatternError(NOT_SUPPORTED))?;
    unsafe { pattern::<IUIAutomationSelectionItemPattern>(e, UIA_SelectionItemPatternId)?.Select().map_err(pe) }
}

pub fn is_selected(r: &Resolved) -> Option<bool> {
    let e = r.elem().ok()?;
    unsafe {
        pattern::<IUIAutomationSelectionItemPattern>(e, UIA_SelectionItemPatternId).ok()?.CurrentIsSelected().ok().map(|b| b.as_bool())
    }
}

pub fn set_focus(r: &Resolved) -> Result<(), PatternError> {
    let e = r.elem().map_err(|_| PatternError(NOT_SUPPORTED))?;
    unsafe { e.SetFocus().map_err(pe) }
}

/// The element's raw value now (`AXValue`: Value pattern, toggle / selection state, range value
/// or document text). `None` for secure fields.
pub fn current_value(u: &Uia, r: &Resolved) -> Option<String> {
    let el = r.node.el()?;
    let fresh = refresh(u, el).ok()?;
    compute(&Node::El(fresh), true).and_then(|c| if c.info.is_secure() { None } else { c.info.value.clone().or(c.info.url.clone()) })
}

/// Full value (snapshots truncate values): the Value pattern's, else the document text.
pub fn full_value(r: &Resolved, max: usize) -> Option<String> {
    let e = r.elem().ok()?;
    let v = unsafe {
        if r.facts.value {
            pattern::<IUIAutomationValuePattern>(e, UIA_ValuePatternId).ok().and_then(|p| p.CurrentValue().ok()).map(|b| b.to_string())
        } else {
            None
        }
    }
    .or_else(|| document_text(e, max.min(i32::MAX as usize) as i32))
    .or_else(|| r.info.value.clone())?;
    Some(if v.chars().count() > max { v.chars().take(max).collect() } else { v })
}

pub fn frame(r: &Resolved) -> Option<Rect> {
    let e = r.elem().ok()?;
    unsafe { e.CurrentBoundingRectangle().ok().map(apps::rect_of) }.filter(|f| f.is_finite())
}

/// The focused element: its pid and whether it is a password field.
pub fn keyboard_focus(u: &Uia) -> (Option<u32>, bool) {
    unsafe {
        match u.auto.GetFocusedElementBuildCache(&u.req_element) {
            Ok(f) => (cached_int(&f, UIA_ProcessIdPropertyId).map(|p| p as u32), cached_bool(&f, UIA_IsPasswordPropertyId)),
            Err(_) => (None, false),
        }
    }
}

/// Whether the focused element is a password field (only counting `app`'s focus when given).
pub fn focused_is_secure(u: &Uia, app: Option<&TargetApp>) -> bool {
    let (pid, secure) = keyboard_focus(u);
    match (app, pid) {
        (Some(a), Some(p)) => secure && a.owns(p),
        _ => secure,
    }
}

/// The element under a screen point (mac `AXEngine.Hit`).
pub struct Hit {
    /// App pid of the top-level window under the point.
    pub pid: u32,
    pub element: Agile<IUIAutomationElement>,
    pub secure: bool,
    pub role: Option<String>,
    /// Names of the hit element and up to two ancestors (risk checks on point clicks).
    pub labels: Vec<String>,
}

pub fn hit_test(u: &Uia, x: f64, y: f64) -> Option<Hit> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let win = apps::window_at(x, y)?;
    let e = unsafe { u.auto.ElementFromPointBuildCache(POINT { x: x.round() as i32, y: y.round() as i32 }, &u.req_element).ok()? };
    let node = node_for(e.clone(), None, false, win.pid, win.hwnd);
    let c = compute(&node, false);
    let mut labels = Vec::new();
    let mut cur = Some(e.clone());
    for _ in 0..3 {
        let Some(el) = cur else { break };
        for p in [UIA_NamePropertyId, UIA_HelpTextPropertyId] {
            if let Some(s) = cached_str(&el, p).filter(|s| !s.is_empty()) {
                labels.push(s);
            }
        }
        cur = unsafe { u.walker.GetParentElementBuildCache(&el, &u.req_element).ok() };
    }
    Some(Hit {
        pid: win.pid,
        secure: c.as_ref().map(|c| c.info.is_secure()).unwrap_or(false),
        role: c.map(|c| c.info.role.clone()),
        element: Agile(e),
        labels,
    })
}

/// True when `hit` is `r`'s element or a descendant of it.
pub fn is_inside(u: &Uia, hit: &Hit, r: &Resolved) -> bool {
    let Some(target) = r.node.el() else { return false };
    let mut cur = Some(hit.element.0.clone());
    for _ in 0..40 {
        let Some(c) = cur else { return false };
        if runtime_id(&c) == *target.key || unsafe { u.auto.CompareElements(&c, &target.e.0) }.map(|b| b.as_bool()).unwrap_or(false) {
            return true;
        }
        cur = unsafe { u.walker.GetParentElement(&c).ok() };
    }
    false
}

/// Waits (≤ `timeout`) for a web document under `root`: Chromium builds its UIA tree lazily
/// after the first client attaches (the Mac's `AXManualAccessibility` wait).
pub fn wait_for_web_area(u: &Uia, root: &Node, timeout: std::time::Duration) {
    let Some(el) = root.el() else { return };
    let deadline = Instant::now() + timeout;
    let cond = unsafe {
        let mut v = VARIANT::default();
        (*v.Anonymous.Anonymous).vt = VT_I4;
        (*v.Anonymous.Anonymous).Anonymous.lVal = ct::DOCUMENT;
        u.auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &v)
    };
    let Ok(cond) = cond else { return };
    while Instant::now() < deadline {
        if unsafe { el.e.0.FindFirst(TreeScope_Descendants, &cond) }.is_ok() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

pub fn hresult(h: HRESULT) -> u32 {
    h.0 as u32
}

pub fn hwnd_of(h: isize) -> HWND {
    apps::hwnd(h)
}
