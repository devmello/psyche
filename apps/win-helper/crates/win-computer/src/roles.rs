//! UI Automation → mac `AX*` role vocabulary. The snapshot builder, the Gateway
//! (`MENU_ROLES`, element map) and the model all speak the mac vocabulary (`button`, `textfield`,
//! `row:outlineRow`, `menubaritem`, …), so the Windows source maps every UIA control type onto it
//! here, as pure data, and the rest of the pipeline is shared.
//!
//! | UIA control type | AX role (subrole) |
//! | --- | --- |
//! | Button | AXButton; with Toggle → AXCheckBox (AXToggle / AXSwitch for ToggleSwitch); with ExpandCollapse → AXMenuButton; title-bar Close / Minimize / Maximize → AXButton (AXCloseButton / AXMinimizeButton / AXZoomButton) |
//! | CheckBox | AXCheckBox |
//! | ComboBox | editable → AXComboBox, else AXPopUpButton |
//! | Edit | AXTextField (AXSecureTextField when IsPassword, AXSearchField for search boxes); multi-line Win32 edits → AXTextArea |
//! | Document | web content (Chromium, WebView2, Gecko, IE) → AXWebArea, else AXTextArea |
//! | Hyperlink / Image / Text (heading) | AXLink / AXImage / AXStaticText (AXHeading) |
//! | List / ListItem / DataItem | AXList / AXRow / AXRow |
//! | Tree / TreeItem | AXOutline / AXRow (AXOutlineRow) |
//! | DataGrid, Table / Header / HeaderItem | AXTable / AXGroup / AXButton (AXSortButton) |
//! | Menu / MenuBar / MenuItem | AXMenu / AXMenuBar / AXMenuItem (AXMenuBarItem under a menu bar) |
//! | Tab / TabItem | AXTabGroup / AXRadioButton (AXTabButton) |
//! | RadioButton, Slider, Spinner, ProgressBar | AXRadioButton, AXSlider, AXIncrementor, AXProgressIndicator |
//! | ToolBar, AppBar / StatusBar / ToolTip | AXToolbar / AXGroup / AXHelpTag |
//! | SplitButton | AXMenuButton |
//! | Window | AXWindow (AXDialog when IsDialog, else AXStandardWindow); a top-level HWND root is always AXWindow |
//! | Pane, Group, Custom, Calendar, SemanticZoom | AXGroup (a container: kept only when labelled) |
//! | TitleBar | AXGroup without a name, so its buttons hoist to the window like the Mac's traffic lights |
//! | ScrollBar / Thumb / Separator | AXScrollBar (pruned) / AXValueIndicator / AXSplitter |

pub mod ct {
    pub const BUTTON: i32 = 50000;
    pub const CALENDAR: i32 = 50001;
    pub const CHECK_BOX: i32 = 50002;
    pub const COMBO_BOX: i32 = 50003;
    pub const EDIT: i32 = 50004;
    pub const HYPERLINK: i32 = 50005;
    pub const IMAGE: i32 = 50006;
    pub const LIST_ITEM: i32 = 50007;
    pub const LIST: i32 = 50008;
    pub const MENU: i32 = 50009;
    pub const MENU_BAR: i32 = 50010;
    pub const MENU_ITEM: i32 = 50011;
    pub const PROGRESS_BAR: i32 = 50012;
    pub const RADIO_BUTTON: i32 = 50013;
    pub const SCROLL_BAR: i32 = 50014;
    pub const SLIDER: i32 = 50015;
    pub const SPINNER: i32 = 50016;
    pub const STATUS_BAR: i32 = 50017;
    pub const TAB: i32 = 50018;
    pub const TAB_ITEM: i32 = 50019;
    pub const TEXT: i32 = 50020;
    pub const TOOL_BAR: i32 = 50021;
    pub const TOOL_TIP: i32 = 50022;
    pub const TREE: i32 = 50023;
    pub const TREE_ITEM: i32 = 50024;
    pub const CUSTOM: i32 = 50025;
    pub const GROUP: i32 = 50026;
    pub const THUMB: i32 = 50027;
    pub const DATA_GRID: i32 = 50028;
    pub const DATA_ITEM: i32 = 50029;
    pub const DOCUMENT: i32 = 50030;
    pub const SPLIT_BUTTON: i32 = 50031;
    pub const WINDOW: i32 = 50032;
    pub const PANE: i32 = 50033;
    pub const HEADER: i32 = 50034;
    pub const HEADER_ITEM: i32 = 50035;
    pub const TABLE: i32 = 50036;
    pub const TITLE_BAR: i32 = 50037;
    pub const SEPARATOR: i32 = 50038;
    pub const SEMANTIC_ZOOM: i32 = 50039;
    pub const APP_BAR: i32 = 50040;
}

/// What the live source knows about one UIA element (all from one cache request).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UiaFacts {
    pub control_type: i32,
    pub parent_control_type: Option<i32>,
    pub automation_id: String,
    pub class_name: String,
    pub framework_id: String,
    pub is_password: bool,
    pub is_dialog: bool,
    pub heading: bool,
    /// The element is the snapshot root and a top-level HWND.
    pub top_level: bool,
    /// Win32 edit with `ES_MULTILINE`.
    pub multiline: bool,
    pub invoke: bool,
    pub toggle: bool,
    pub selection_item: bool,
    pub expand_collapse: bool,
    pub value: bool,
    pub value_read_only: bool,
    pub range_value: bool,
    pub range_read_only: bool,
    pub window: bool,
    pub legacy_default_action: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mapped {
    pub role: &'static str,
    pub subrole: Option<&'static str>,
    /// UIA `Name` is the element's text, not its title (static text): it goes to `value`.
    pub name_is_value: bool,
    /// The name is chrome (title bar): drop it so the container hoists its children.
    pub drop_name: bool,
}

fn m(role: &'static str, subrole: Option<&'static str>) -> Mapped {
    Mapped { role, subrole, name_is_value: false, drop_name: false }
}

fn is_web_framework(f: &UiaFacts) -> bool {
    matches!(f.framework_id.as_str(), "Chrome" | "Gecko" | "InternetExplorer" | "WebView")
        || f.class_name.contains("Chrome_RenderWidgetHostHWND")
        || f.class_name == "Internet Explorer_Server"
        || f.class_name.starts_with("MozillaWindowClass")
}

fn looks_like_search(f: &UiaFacts) -> bool {
    let id = f.automation_id.to_ascii_lowercase();
    let class = f.class_name.to_ascii_lowercase();
    id.contains("search") || class.contains("searchbox") || class.contains("autosuggestbox")
}

/// UIA control type (plus a few facts) → mac role and subrole.
pub fn map_role(f: &UiaFacts) -> Mapped {
    use ct::*;
    if f.top_level && matches!(f.control_type, WINDOW | PANE) {
        return m("AXWindow", Some(if f.is_dialog { "AXDialog" } else { "AXStandardWindow" }));
    }
    match f.control_type {
        BUTTON => {
            if f.toggle {
                let sub = if f.class_name.contains("ToggleSwitch") { "AXSwitch" } else { "AXToggle" };
                return m("AXCheckBox", Some(sub));
            }
            let in_title_bar = f.parent_control_type == Some(TITLE_BAR);
            let id = f.automation_id.as_str();
            // Win32 title bars use Close / Minimize / Maximize; XAML ones `Minimize-Restore`.
            if in_title_bar && id == "Close" {
                m("AXButton", Some("AXCloseButton"))
            } else if in_title_bar && id.starts_with("Minimize") {
                m("AXButton", Some("AXMinimizeButton"))
            } else if in_title_bar && (id.starts_with("Maximize") || id.starts_with("Restore")) {
                m("AXButton", Some("AXZoomButton"))
            } else if f.expand_collapse && !f.invoke {
                m("AXMenuButton", None)
            } else {
                m("AXButton", None)
            }
        }
        CHECK_BOX => m("AXCheckBox", None),
        COMBO_BOX => {
            if f.value && !f.value_read_only {
                m("AXComboBox", None)
            } else {
                m("AXPopUpButton", None)
            }
        }
        EDIT => {
            if f.is_password {
                m("AXTextField", Some("AXSecureTextField"))
            } else if f.multiline {
                m("AXTextArea", None)
            } else if looks_like_search(f) {
                m("AXTextField", Some("AXSearchField"))
            } else {
                m("AXTextField", None)
            }
        }
        DOCUMENT => {
            if is_web_framework(f) {
                m("AXWebArea", None)
            } else {
                m("AXTextArea", None)
            }
        }
        HYPERLINK => m("AXLink", None),
        IMAGE => m("AXImage", None),
        TEXT => Mapped {
            role: if f.heading { "AXHeading" } else { "AXStaticText" },
            subrole: None,
            name_is_value: !f.heading,
            drop_name: false,
        },
        LIST => m("AXList", None),
        LIST_ITEM | DATA_ITEM => m("AXRow", None),
        TREE => m("AXOutline", None),
        TREE_ITEM => m("AXRow", Some("AXOutlineRow")),
        DATA_GRID | TABLE => m("AXTable", None),
        HEADER => m("AXGroup", None),
        HEADER_ITEM => m("AXButton", Some("AXSortButton")),
        MENU => m("AXMenu", None),
        MENU_BAR => m("AXMenuBar", None),
        MENU_ITEM => {
            if f.parent_control_type == Some(MENU_BAR) {
                m("AXMenuBarItem", None)
            } else {
                m("AXMenuItem", None)
            }
        }
        TAB => m("AXTabGroup", None),
        TAB_ITEM => m("AXRadioButton", Some("AXTabButton")),
        RADIO_BUTTON => m("AXRadioButton", None),
        SLIDER => m("AXSlider", None),
        SPINNER => m("AXIncrementor", None),
        PROGRESS_BAR => m("AXProgressIndicator", None),
        TOOL_BAR | APP_BAR => m("AXToolbar", None),
        STATUS_BAR => m("AXGroup", None),
        TOOL_TIP => m("AXHelpTag", None),
        SPLIT_BUTTON => m("AXMenuButton", None),
        WINDOW => m("AXWindow", Some(if f.is_dialog { "AXDialog" } else { "AXStandardWindow" })),
        TITLE_BAR => Mapped { role: "AXGroup", subrole: None, name_is_value: false, drop_name: true },
        SCROLL_BAR => m("AXScrollBar", None),
        THUMB => m("AXValueIndicator", None),
        SEPARATOR => m("AXSplitter", None),
        PANE | GROUP | CUSTOM | CALENDAR | SEMANTIC_ZOOM => m("AXGroup", None),
        _ => m("AXUnknown", None),
    }
}

/// Item-like elements whose Invoke opens them (Explorer files, list entries): their Invoke is
/// `AXOpen`, never `AXPress`, so a "click" selects (mouse fallback) instead of opening.
fn is_item(control_type: i32) -> bool {
    matches!(control_type, ct::LIST_ITEM | ct::DATA_ITEM | ct::TREE_ITEM)
}

/// Raw AX action names an element offers, from its UIA patterns.
pub fn actions(f: &UiaFacts, role: &str) -> Vec<String> {
    let mut out: Vec<&'static str> = Vec::new();
    let item = is_item(f.control_type);
    let mut press = false;
    if f.invoke && !item {
        press = true;
    }
    if f.toggle {
        press = true;
    }
    if f.selection_item && matches!(f.control_type, ct::RADIO_BUTTON | ct::TAB_ITEM) {
        press = true;
    }
    let menuish = matches!(role, "AXMenuItem" | "AXMenuBarItem" | "AXMenuButton" | "AXPopUpButton" | "AXComboBox");
    if f.expand_collapse && !press && (menuish || f.control_type == ct::TREE_ITEM || f.control_type == ct::BUTTON) && role != "AXComboBox" {
        press = true; // pressing expands / collapses
    }
    if !press
        && f.legacy_default_action
        && matches!(
            f.control_type,
            ct::BUTTON | ct::CHECK_BOX | ct::RADIO_BUTTON | ct::MENU_ITEM | ct::HYPERLINK | ct::SPLIT_BUTTON | ct::TAB_ITEM
        )
    {
        press = true;
    }
    if press {
        out.push("AXPress");
    }
    if f.expand_collapse && menuish && role != "AXMenuItem" && role != "AXMenuBarItem" {
        out.push("AXShowMenu");
    }
    if f.invoke && item {
        out.push("AXOpen");
    }
    if f.range_value && !f.range_read_only && matches!(f.control_type, ct::SLIDER | ct::SPINNER) {
        out.push("AXIncrement");
        out.push("AXDecrement");
    }
    if f.window && (f.control_type == ct::WINDOW || f.top_level) {
        out.push("AXRaise");
    }
    out.into_iter().map(str::to_string).collect()
}

/// Whether `AXValue` is settable (text inputs and sliders).
pub fn value_settable(f: &UiaFacts) -> bool {
    (f.value && !f.value_read_only) || (f.range_value && !f.range_read_only && matches!(f.control_type, ct::SLIDER | ct::SPINNER))
}

/// Formats a number like `NSNumber.stringValue` (integers without a fraction).
pub fn number_string(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(ct: i32) -> UiaFacts {
        UiaFacts { control_type: ct, ..Default::default() }
    }

    #[test]
    fn maps_common_controls() {
        assert_eq!(map_role(&f(ct::BUTTON)).role, "AXButton");
        assert_eq!(map_role(&UiaFacts { toggle: true, ..f(ct::BUTTON) }), m("AXCheckBox", Some("AXToggle")));
        assert_eq!(map_role(&UiaFacts { is_password: true, ..f(ct::EDIT) }), m("AXTextField", Some("AXSecureTextField")));
        assert_eq!(map_role(&UiaFacts { multiline: true, ..f(ct::EDIT) }).role, "AXTextArea");
        assert_eq!(map_role(&UiaFacts { value: true, ..f(ct::COMBO_BOX) }).role, "AXComboBox");
        assert_eq!(map_role(&UiaFacts { value: true, value_read_only: true, ..f(ct::COMBO_BOX) }).role, "AXPopUpButton");
        assert_eq!(map_role(&UiaFacts { framework_id: "Chrome".into(), ..f(ct::DOCUMENT) }).role, "AXWebArea");
        assert_eq!(map_role(&UiaFacts { framework_id: "XAML".into(), ..f(ct::DOCUMENT) }).role, "AXTextArea");
        assert_eq!(map_role(&UiaFacts { parent_control_type: Some(ct::MENU_BAR), ..f(ct::MENU_ITEM) }).role, "AXMenuBarItem");
        assert_eq!(map_role(&f(ct::MENU_ITEM)).role, "AXMenuItem");
        assert_eq!(map_role(&f(ct::TREE_ITEM)), m("AXRow", Some("AXOutlineRow")));
        assert_eq!(map_role(&f(ct::TAB_ITEM)), m("AXRadioButton", Some("AXTabButton")));
        assert!(map_role(&f(ct::TEXT)).name_is_value);
        assert!(!map_role(&UiaFacts { heading: true, ..f(ct::TEXT) }).name_is_value);
        assert!(map_role(&f(ct::TITLE_BAR)).drop_name);
        assert_eq!(map_role(&UiaFacts { top_level: true, ..f(ct::PANE) }), m("AXWindow", Some("AXStandardWindow")));
        assert_eq!(map_role(&UiaFacts { is_dialog: true, ..f(ct::WINDOW) }), m("AXWindow", Some("AXDialog")));
        let close = UiaFacts { automation_id: "Close".into(), parent_control_type: Some(ct::TITLE_BAR), invoke: true, ..f(ct::BUTTON) };
        assert_eq!(map_role(&close), m("AXButton", Some("AXCloseButton")));
        assert_eq!(map_role(&f(9999)).role, "AXUnknown");
    }

    #[test]
    fn role_names_match_the_mac_vocabulary() {
        use crate::snapshot::text::role_name;
        let name = |x: &UiaFacts| {
            let r = map_role(x);
            role_name(r.role, r.subrole)
        };
        assert_eq!(name(&UiaFacts { is_password: true, ..f(ct::EDIT) }), "textfield:secureTextField");
        assert_eq!(name(&f(ct::TEXT)), "text");
        assert_eq!(name(&UiaFacts { parent_control_type: Some(ct::MENU_BAR), ..f(ct::MENU_ITEM) }), "menubaritem");
        assert_eq!(name(&f(ct::TREE_ITEM)), "row:outlineRow");
        assert_eq!(name(&f(ct::HEADER_ITEM)), "button:sortButton");
    }

    #[test]
    fn actions_from_patterns() {
        let b = UiaFacts { invoke: true, ..f(ct::BUTTON) };
        assert_eq!(actions(&b, "AXButton"), vec!["AXPress"]);
        let item = UiaFacts { invoke: true, selection_item: true, ..f(ct::LIST_ITEM) };
        assert_eq!(actions(&item, "AXRow"), vec!["AXOpen"]);
        let combo = UiaFacts { expand_collapse: true, value: true, value_read_only: true, ..f(ct::COMBO_BOX) };
        assert_eq!(actions(&combo, "AXPopUpButton"), vec!["AXPress", "AXShowMenu"]);
        let slider = UiaFacts { range_value: true, ..f(ct::SLIDER) };
        assert_eq!(actions(&slider, "AXSlider"), vec!["AXIncrement", "AXDecrement"]);
        let legacy_only = UiaFacts { legacy_default_action: true, ..f(ct::BUTTON) };
        assert_eq!(actions(&legacy_only, "AXButton"), vec!["AXPress"]);
        let legacy_item = UiaFacts { legacy_default_action: true, ..f(ct::LIST_ITEM) };
        assert!(actions(&legacy_item, "AXRow").is_empty(), "an item's default action (double click) is never a press");
        let radio = UiaFacts { selection_item: true, ..f(ct::RADIO_BUTTON) };
        assert_eq!(actions(&radio, "AXRadioButton"), vec!["AXPress"]);
        let menu = UiaFacts { expand_collapse: true, ..f(ct::MENU_ITEM) };
        assert_eq!(actions(&menu, "AXMenuItem"), vec!["AXPress"]);
        assert!(value_settable(&UiaFacts { value: true, ..f(ct::EDIT) }));
        assert!(!value_settable(&UiaFacts { value: true, value_read_only: true, ..f(ct::EDIT) }));
    }

    #[test]
    fn numbers_format_like_nsnumber() {
        assert_eq!(number_string(50.0), "50");
        assert_eq!(number_string(0.5), "0.5");
        assert_eq!(number_string(-3.0), "-3");
    }
}
