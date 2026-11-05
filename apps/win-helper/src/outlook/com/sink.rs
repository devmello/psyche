//! The `ItemsEvents` sink `calendar.watch` advises on each calendar folder's `Items`: Outlook
//! calls `Invoke` with `ItemAdd` (0xF001), `ItemChange` (0xF002) or `ItemRemove` (0xF003) on the
//! STA thread (through its message pump). The sink only says "something changed".

#![allow(non_snake_case)]

use std::sync::{Arc, Mutex};

use windows::Win32::Foundation::E_NOTIMPL;
use windows::Win32::System::Com::{
    DISPATCH_FLAGS, DISPPARAMS, EXCEPINFO, IDispatch, IDispatch_Impl, IDispatch_Vtbl, ITypeInfo,
};
use windows::Win32::System::Variant::VARIANT;
use windows::core::{GUID, PCWSTR, implement, interface};

/// Outlook's `ItemsEvents` dispinterface ({00063077-0000-0000-C000-000000000046}).
#[interface("00063077-0000-0000-C000-000000000046")]
pub unsafe trait ItemsEvents: IDispatch {}

pub const ITEM_ADD: i32 = 0xF001;
pub const ITEM_CHANGE: i32 = 0xF002;
pub const ITEM_REMOVE: i32 = 0xF003;

pub type ChangeFn = Arc<dyn Fn() + Send + Sync>;

/// Shared so the watch can be switched off before COM releases the sink (a dead Outlook keeps
/// its references until COM's garbage collection notices).
pub type Slot = Arc<Mutex<Option<ChangeFn>>>;

#[implement(ItemsEvents)]
pub struct ItemsSink {
    pub slot: Slot,
}

/// Whether a dispatch id is one of the three item events.
pub fn is_item_event(dispid: i32) -> bool {
    matches!(dispid, ITEM_ADD | ITEM_CHANGE | ITEM_REMOVE)
}

impl IDispatch_Impl for ItemsSink_Impl {
    fn GetTypeInfoCount(&self) -> windows::core::Result<u32> {
        Ok(0)
    }

    fn GetTypeInfo(&self, _itinfo: u32, _lcid: u32) -> windows::core::Result<ITypeInfo> {
        Err(E_NOTIMPL.into())
    }

    fn GetIDsOfNames(
        &self,
        _riid: *const GUID,
        _names: *const PCWSTR,
        _cnames: u32,
        _lcid: u32,
        _ids: *mut i32,
    ) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Invoke(
        &self,
        dispid: i32,
        _riid: *const GUID,
        _lcid: u32,
        _flags: DISPATCH_FLAGS,
        _params: *const DISPPARAMS,
        _result: *mut VARIANT,
        _excepinfo: *mut EXCEPINFO,
        _argerr: *mut u32,
    ) -> windows::core::Result<()> {
        if is_item_event(dispid) {
            let cb = self.slot.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some(cb) = cb {
                cb();
            }
        }
        Ok(())
    }
}

impl ItemsEvents_Impl for ItemsSink_Impl {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows::core::Interface;

    #[test]
    fn the_sink_answers_for_items_events_and_counts_item_events() {
        crate::win::com::ensure_mta();
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        let slot: Slot = Arc::new(Mutex::new(Some(Arc::new(move || {
            n2.fetch_add(1, Ordering::SeqCst);
        }))));
        let sink: ItemsEvents = ItemsSink { slot: slot.clone() }.into();
        // Outlook's connection point asks the sink for the event interface and IDispatch.
        let d: IDispatch = sink.cast().unwrap();
        let params = DISPPARAMS::default();
        for id in [ITEM_ADD, ITEM_CHANGE, ITEM_REMOVE, 0x1234] {
            // SAFETY: no arguments, no result.
            unsafe {
                d.Invoke(
                    id,
                    &GUID::zeroed(),
                    0,
                    DISPATCH_FLAGS(1),
                    &params,
                    None,
                    None,
                    None,
                )
                .unwrap()
            };
        }
        assert_eq!(n.load(Ordering::SeqCst), 3);
        // Switched off: further events are ignored.
        *slot.lock().unwrap() = None;
        // SAFETY: as above.
        unsafe {
            d.Invoke(
                ITEM_ADD,
                &GUID::zeroed(),
                0,
                DISPATCH_FLAGS(1),
                &params,
                None,
                None,
                None,
            )
            .unwrap()
        };
        assert_eq!(n.load(Ordering::SeqCst), 3);
        assert_eq!(
            <ItemsEvents as Interface>::IID,
            GUID::from_u128(0x00063077_0000_0000_c000_000000000046)
        );
    }
}
