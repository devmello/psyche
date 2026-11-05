//! Late-bound `IDispatch` calls with owned `VARIANT`s. Every call checks the current job's
//! deadline first (`sta::check_deadline`), retries while Outlook rejects calls because it is busy
//! (`RPC_E_CALL_REJECTED`, until the deadline), and maps failures through `errors::map` with
//! nothing but the HRESULT. Dispatch ids are cached per (object kind, member name) and resolved
//! again when a cached id is refused.

use std::cell::RefCell;
use std::collections::HashMap;
use std::mem::ManuallyDrop;

use windows::Win32::Foundation::VARIANT_BOOL;
use windows::Win32::System::Com::{
    DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS,
    EXCEPINFO, IDispatch,
};
use windows::Win32::System::Ole::DISPID_PROPERTYPUT;
use windows::Win32::System::Variant::{
    VAR_CHANGE_FLAGS, VARENUM, VARIANT, VT_BOOL, VT_BSTR, VT_DATE, VT_DISPATCH, VT_EMPTY, VT_ERROR,
    VT_I4, VT_NULL, VT_R8, VT_UNKNOWN, VariantChangeType, VariantClear,
};
use windows::core::{BSTR, GUID, Interface, PCWSTR};

use super::super::errors::{self, DISP_E_EXCEPTION, DISP_E_MEMBERNOTFOUND, DISP_E_UNKNOWNNAME};
use super::sta::{check_deadline, pump_for};
use crate::node::capability::CapabilityError;

pub type CR<T> = Result<T, CapabilityError>;

const LOCALE_USER_DEFAULT: u32 = 0x0400;
const DISP_E_PARAMNOTFOUND: i32 = 0x8002_0004u32 as i32;

/// An owned `VARIANT` (cleared on drop).
#[repr(transparent)]
#[derive(Default)]
pub struct Var(pub VARIANT);

impl Drop for Var {
    fn drop(&mut self) {
        // SAFETY: the variant is owned and initialised.
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

impl Var {
    fn with(vt: VARENUM, set: impl FnOnce(&mut VARIANT)) -> Var {
        let mut v = VARIANT::default();
        // SAFETY: writing the tag and the matching union member of a zeroed variant.
        unsafe {
            (*v.Anonymous.Anonymous).vt = vt;
        }
        set(&mut v);
        Var(v)
    }

    /// An omitted optional argument.
    pub fn missing() -> Var {
        Var::with(VT_ERROR, |v| unsafe {
            (*v.Anonymous.Anonymous).Anonymous.scode = DISP_E_PARAMNOTFOUND
        })
    }

    pub fn int(x: i32) -> Var {
        Var::with(VT_I4, |v| unsafe {
            (*v.Anonymous.Anonymous).Anonymous.lVal = x
        })
    }

    pub fn flag(x: bool) -> Var {
        Var::with(VT_BOOL, |v| unsafe {
            (*v.Anonymous.Anonymous).Anonymous.boolVal = VARIANT_BOOL(if x { -1 } else { 0 })
        })
    }

    pub fn real(x: f64) -> Var {
        Var::with(VT_R8, |v| unsafe {
            (*v.Anonymous.Anonymous).Anonymous.dblVal = x
        })
    }

    /// An OLE automation date.
    pub fn date(x: f64) -> Var {
        Var::with(VT_DATE, |v| unsafe {
            (*v.Anonymous.Anonymous).Anonymous.date = x
        })
    }

    pub fn str(s: &str) -> Var {
        Var::with(VT_BSTR, |v| unsafe {
            (*v.Anonymous.Anonymous).Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(s))
        })
    }

    pub fn disp(d: &Disp) -> Var {
        Var::with(VT_DISPATCH, |v| unsafe {
            (*v.Anonymous.Anonymous).Anonymous.pdispVal = ManuallyDrop::new(Some(d.d.clone()))
        })
    }

    pub fn vt(&self) -> VARENUM {
        // SAFETY: reading the tag.
        unsafe { self.0.Anonymous.Anonymous.vt }
    }

    pub fn is_empty(&self) -> bool {
        matches!(self.vt(), VT_EMPTY | VT_NULL)
    }

    fn changed(&self, vt: VARENUM) -> Option<Var> {
        let mut out = Var::default();
        // SAFETY: both variants are valid; `out` is owned and cleared on drop.
        unsafe { VariantChangeType(&mut out.0, &self.0, VAR_CHANGE_FLAGS(0), vt).ok()? };
        Some(out)
    }

    /// Text (empty for empty / null / not convertible).
    pub fn string(&self) -> String {
        if self.is_empty() {
            return String::new();
        }
        let read = |v: &Var| unsafe { (*v.0.Anonymous.Anonymous.Anonymous.bstrVal).to_string() };
        if self.vt() == VT_BSTR {
            return read(self);
        }
        self.changed(VT_BSTR).map(|v| read(&v)).unwrap_or_default()
    }

    pub fn i32(&self) -> i32 {
        if self.vt() == VT_I4 {
            // SAFETY: tag checked.
            return unsafe { self.0.Anonymous.Anonymous.Anonymous.lVal };
        }
        self.changed(VT_I4)
            .map(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.lVal })
            .unwrap_or(0)
    }

    pub fn bool(&self) -> bool {
        if self.vt() == VT_BOOL {
            // SAFETY: tag checked.
            return unsafe { self.0.Anonymous.Anonymous.Anonymous.boolVal.0 != 0 };
        }
        self.changed(VT_BOOL)
            .is_some_and(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.boolVal.0 != 0 })
    }

    /// A date or number as `f64` (NaN when neither).
    pub fn f64(&self) -> f64 {
        match self.vt() {
            // SAFETY: tags checked.
            VT_DATE => unsafe { self.0.Anonymous.Anonymous.Anonymous.date },
            VT_R8 => unsafe { self.0.Anonymous.Anonymous.Anonymous.dblVal },
            _ => self
                .changed(VT_R8)
                .map(|v| unsafe { v.0.Anonymous.Anonymous.Anonymous.dblVal })
                .unwrap_or(f64::NAN),
        }
    }

    pub fn dispatch(&self) -> Option<IDispatch> {
        match self.vt() {
            // SAFETY: tags checked; the interface is cloned (AddRef), the variant keeps its own.
            VT_DISPATCH => unsafe { (*self.0.Anonymous.Anonymous.Anonymous.pdispVal).clone() },
            VT_UNKNOWN => unsafe {
                (*self.0.Anonymous.Anonymous.Anonymous.punkVal)
                    .as_ref()
                    .and_then(|u| u.cast::<IDispatch>().ok())
            },
            _ => None,
        }
    }
}

thread_local! {
    static DISPIDS: RefCell<HashMap<(&'static str, String), i32>> = RefCell::new(HashMap::new());
}

/// An Outlook object, tagged with its kind (the dispatch id cache key; an empty kind, for objects
/// whose class is not known yet, is never cached).
#[derive(Clone)]
pub struct Disp {
    pub d: IDispatch,
    pub kind: &'static str,
}

fn hr_of(e: &windows::core::Error) -> u32 {
    e.code().0 as u32
}

impl Disp {
    pub fn new(d: IDispatch, kind: &'static str) -> Disp {
        Disp { d, kind }
    }

    fn lookup(&self, name: &str) -> CR<i32> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let names = [PCWSTR(wide.as_ptr())];
        let mut id = 0i32;
        // SAFETY: one NUL-terminated name, one output slot.
        unsafe {
            self.d
                .GetIDsOfNames(
                    &GUID::zeroed(),
                    names.as_ptr(),
                    1,
                    LOCALE_USER_DEFAULT,
                    &mut id,
                )
                .map_err(|e| errors::map(hr_of(&e), None))?;
        }
        if !self.kind.is_empty() {
            DISPIDS.with(|c| c.borrow_mut().insert((self.kind, name.to_owned()), id));
        }
        Ok(id)
    }

    fn dispid(&self, name: &str) -> CR<i32> {
        match DISPIDS.with(|c| c.borrow().get(&(self.kind, name.to_owned())).copied()) {
            Some(id) => Ok(id),
            None => self.lookup(name),
        }
    }

    fn raw_invoke(
        &self,
        id: i32,
        flags: DISPATCH_FLAGS,
        args: &mut [Var],
    ) -> Result<Var, (u32, Option<u32>)> {
        let mut named = DISPID_PROPERTYPUT;
        let put = flags == DISPATCH_PROPERTYPUT;
        let params = DISPPARAMS {
            rgvarg: args.as_mut_ptr() as *mut VARIANT,
            rgdispidNamedArgs: if put {
                &mut named
            } else {
                std::ptr::null_mut()
            },
            cArgs: args.len() as u32,
            cNamedArgs: u32::from(put),
        };
        let mut result = Var::default();
        let mut ex = EXCEPINFO::default();
        let mut arg_err = 0u32;
        // SAFETY: `args` outlive the call (reversed by the caller as IDispatch expects); the
        // result and the exception info are owned here.
        let r = unsafe {
            self.d.Invoke(
                id,
                &GUID::zeroed(),
                LOCALE_USER_DEFAULT,
                flags,
                &params,
                Some(&mut result.0 as *mut VARIANT),
                Some(&mut ex as *mut EXCEPINFO),
                Some(&mut arg_err as *mut u32),
            )
        };
        let scode = (ex.scode != 0).then_some(ex.scode as u32);
        // SAFETY: the exception's strings are owned by the caller of Invoke.
        unsafe {
            ManuallyDrop::drop(&mut ex.bstrSource);
            ManuallyDrop::drop(&mut ex.bstrDescription);
            ManuallyDrop::drop(&mut ex.bstrHelpFile);
        }
        match r {
            Ok(()) => Ok(result),
            Err(e) => Err((hr_of(&e), scode)),
        }
    }

    /// Invokes `name` with `args` (in call order).
    pub fn invoke(&self, name: &str, flags: DISPATCH_FLAGS, mut args: Vec<Var>) -> CR<Var> {
        args.reverse();
        let mut id = self.dispid(name)?;
        let mut refreshed = false;
        loop {
            check_deadline()?;
            match self.raw_invoke(id, flags, &mut args) {
                Ok(v) => return Ok(v),
                Err((hr, _)) if errors::is_retry_later(hr) => {
                    pump_for(std::time::Duration::from_millis(100))
                }
                Err((hr, _))
                    if !refreshed && matches!(hr, DISP_E_MEMBERNOTFOUND | DISP_E_UNKNOWNNAME) =>
                {
                    refreshed = true;
                    id = self.lookup(name)?;
                }
                Err((hr, scode)) => {
                    let sc = if hr == DISP_E_EXCEPTION { scode } else { None };
                    return Err(errors::map(hr, sc));
                }
            }
        }
    }

    pub fn get(&self, name: &str) -> CR<Var> {
        self.invoke(name, DISPATCH_PROPERTYGET, Vec::new())
    }

    pub fn get_with(&self, name: &str, args: Vec<Var>) -> CR<Var> {
        self.invoke(name, DISPATCH_PROPERTYGET | DISPATCH_METHOD, args)
    }

    pub fn put(&self, name: &str, value: Var) -> CR<()> {
        self.invoke(name, DISPATCH_PROPERTYPUT, vec![value])
            .map(|_| ())
    }

    pub fn call(&self, name: &str, args: Vec<Var>) -> CR<Var> {
        self.invoke(name, DISPATCH_METHOD, args)
    }

    pub fn string(&self, name: &str) -> CR<String> {
        Ok(self.get(name)?.string())
    }

    pub fn i32(&self, name: &str) -> CR<i32> {
        Ok(self.get(name)?.i32())
    }

    pub fn bool(&self, name: &str) -> CR<bool> {
        Ok(self.get(name)?.bool())
    }

    pub fn f64(&self, name: &str) -> CR<f64> {
        Ok(self.get(name)?.f64())
    }

    /// A child object, or `outlook_error` when the property is empty.
    pub fn obj(&self, name: &str, kind: &'static str) -> CR<Disp> {
        self.get(name)?
            .dispatch()
            .map(|d| Disp::new(d, kind))
            .ok_or_else(|| {
                CapabilityError::unavailable("outlook_error", "Outlook returned no object")
            })
    }

    /// A child object, None when empty.
    pub fn obj_opt(&self, name: &str, kind: &'static str) -> CR<Option<Disp>> {
        Ok(self.get(name)?.dispatch().map(|d| Disp::new(d, kind)))
    }

    /// Calls a method returning an object.
    pub fn call_obj(&self, name: &str, args: Vec<Var>, kind: &'static str) -> CR<Disp> {
        self.call(name, args)?
            .dispatch()
            .map(|d| Disp::new(d, kind))
            .ok_or_else(|| {
                CapabilityError::unavailable("outlook_error", "Outlook returned no object")
            })
    }

    /// `Item(i)` (1-based) of a collection.
    pub fn item(&self, i: i32, kind: &'static str) -> CR<Option<Disp>> {
        Ok(self
            .get_with("Item", vec![Var::int(i)])?
            .dispatch()
            .map(|d| Disp::new(d, kind)))
    }

    pub fn count(&self) -> CR<i32> {
        self.i32("Count")
    }

    /// Reads a property, the empty value when Outlook refuses it (properties some item classes or
    /// versions lack). Timeouts and disconnects still fail.
    pub fn soft(&self, name: &str) -> CR<Var> {
        match self.get(name) {
            Ok(v) => Ok(v),
            Err(e)
                if matches!(
                    e.reason.as_str(),
                    "outlook_error" | "outlook_object_model" | "not_found"
                ) =>
            {
                Ok(Var::default())
            }
            Err(e) => Err(e),
        }
    }

    pub fn soft_string(&self, name: &str) -> CR<String> {
        Ok(self.soft(name)?.string())
    }
}
