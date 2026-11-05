//! Shell helpers: known folders, ShellExecute, Explorer reveal, Start-menu shortcuts, the
//! AppsFolder (every Start-menu app, packaged or Win32), natural sort.

use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{CloseHandle, PROPERTYKEY};
use windows::Win32::Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_AppUserModel_ToastActivatorCLSID, PKEY_Link_TargetParsingPath};
use windows::Win32::System::Com::StructuredStorage::{InitPropVariantFromCLSID, PROPVARIANT};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, CoCreateInstance, CoTaskMemFree, IPersistFile};
use windows::Win32::System::Threading::GetProcessId;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    AO_NONE, ApplicationActivationManager, BHID_EnumItems, FOLDERID_AppsFolder, IApplicationActivationManager, IEnumShellItems,
    IShellItem, IShellItem2, IShellLinkW, ILCreateFromPathW, ILFree, KF_FLAG_DEFAULT, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
    SHELLEXECUTEINFOW, SHGetKnownFolderItem, SHGetKnownFolderPath, SHOpenFolderAndSelectItems, SIGDN_NORMALDISPLAY,
    SIGDN_PARENTRELATIVEPARSING, ShellExecuteExW, ShellLink, StrCmpLogicalW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{GUID, HSTRING, Interface, PCWSTR, PWSTR};

fn take_pwstr(p: PWSTR) -> Option<String> {
    if p.is_null() {
        return None;
    }
    // SAFETY: shell-allocated string, freed after the copy.
    unsafe {
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

pub fn known_folder(id: &GUID) -> Option<PathBuf> {
    // SAFETY: the returned string is freed by take_pwstr.
    take_pwstr(unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None) }.ok()?).map(PathBuf::from)
}

/// `ShellExecuteEx` "open" of a file, folder or URI. Returns the started process id when the
/// shell started one directly (DDE / already-running handlers return none).
pub fn shell_open(file: &str, parameters: Option<&str>) -> windows::core::Result<Option<u32>> {
    let f = HSTRING::from(file);
    let p = parameters.map(HSTRING::from);
    let verb = HSTRING::from("open");
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(f.as_ptr()),
        lpParameters: p.as_ref().map_or(PCWSTR::null(), |p| PCWSTR(p.as_ptr())),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    // SAFETY: the strings outlive the call; the process handle is closed here.
    unsafe {
        ShellExecuteExW(&mut info)?;
        if info.hProcess.is_invalid() {
            return Ok(None);
        }
        let pid = GetProcessId(info.hProcess);
        let _ = CloseHandle(info.hProcess);
        Ok((pid != 0).then_some(pid))
    }
}

/// Activates a packaged app by AppUserModelID; returns its process id.
pub fn activate_packaged(aumid: &str, arguments: Option<&str>) -> windows::core::Result<u32> {
    // SAFETY: COM activation through the system's activation manager.
    unsafe {
        let mgr: IApplicationActivationManager = CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)?;
        mgr.ActivateApplication(&HSTRING::from(aumid), &HSTRING::from(arguments.unwrap_or("")), AO_NONE)
    }
}

/// Opens an Explorer window on the item's folder with the item selected.
pub fn reveal(path: &Path) -> windows::core::Result<()> {
    let p = HSTRING::from(path.as_os_str());
    // SAFETY: the PIDL is freed after the call.
    unsafe {
        let pidl: *mut ITEMIDLIST = ILCreateFromPathW(&p);
        if pidl.is_null() {
            return Err(windows::core::Error::from_thread());
        }
        let r = SHOpenFolderAndSelectItems(pidl, None, 0);
        ILFree(Some(pidl));
        r
    }
}

/// Natural ("Explorer") ordering of names, as `localizedStandardCompare` does on the Mac.
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    // SAFETY: both strings are NUL-terminated for the call.
    let r = unsafe { StrCmpLogicalW(&HSTRING::from(a), &HSTRING::from(b)) };
    r.cmp(&0)
}

/// Creates (or overwrites) a `.lnk` with the AppUserModelID and toast activator CLSID set.
pub fn write_shortcut(lnk: &Path, target: &Path, arguments: &str, description: &str, aumid: &str, activator: &GUID) -> windows::core::Result<()> {
    // SAFETY: COM calls on freshly created shell-link objects.
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(target.as_os_str()))?;
        link.SetArguments(&HSTRING::from(arguments))?;
        link.SetDescription(&HSTRING::from(description))?;
        if let Some(dir) = target.parent() {
            link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
        }
        let store: IPropertyStore = link.cast()?;
        store.SetValue(&PKEY_AppUserModel_ID, &PROPVARIANT::from(aumid))?;
        store.SetValue(&PKEY_AppUserModel_ToastActivatorCLSID, &InitPropVariantFromCLSID(activator)?)?;
        store.Commit()?;
        if let Some(dir) = lnk.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file: IPersistFile = link.cast()?;
        file.Save(&HSTRING::from(lnk.as_os_str()), true)
    }
}

fn item_string(item: &IShellItem, key: &PROPERTYKEY) -> Option<String> {
    let item2: IShellItem2 = item.cast().ok()?;
    // SAFETY: the string is freed by take_pwstr.
    take_pwstr(unsafe { item2.GetString(key) }.ok()?).filter(|s| !s.is_empty())
}

/// A `.lnk`'s target path and AppUserModelID.
pub fn read_shortcut(lnk: &Path) -> Option<(Option<String>, Option<String>)> {
    // SAFETY: shell item over an existing file.
    unsafe {
        let item: IShellItem = windows::Win32::UI::Shell::SHCreateItemFromParsingName(&HSTRING::from(lnk.as_os_str()), None).ok()?;
        Some((item_string(&item, &PKEY_Link_TargetParsingPath), item_string(&item, &PKEY_AppUserModel_ID)))
    }
}

/// One Start-menu app from `shell:AppsFolder`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartApp {
    pub name: String,
    /// The AppsFolder parsing name: an AppUserModelID (packaged apps contain `!`).
    pub app_id: String,
    /// Target executable for Win32 shortcuts.
    pub target: Option<String>,
}

/// Every app in `shell:AppsFolder`.
pub fn start_apps() -> Vec<StartApp> {
    let mut out = Vec::new();
    // SAFETY: COM enumeration; every string is freed by take_pwstr.
    unsafe {
        let Ok(folder) = SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None) else { return out };
        let Ok(items) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else { return out };
        loop {
            let mut batch: [Option<IShellItem>; 1] = [None];
            let mut fetched = 0u32;
            if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = batch[0].take() else { break };
            let name = item.GetDisplayName(SIGDN_NORMALDISPLAY).ok().and_then(|p| take_pwstr(p));
            let id = item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING).ok().and_then(|p| take_pwstr(p));
            if let (Some(name), Some(app_id)) = (name, id) {
                let target = item_string(&item, &PKEY_Link_TargetParsingPath);
                out.push(StartApp { name, app_id, target });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order() {
        assert_eq!(natural_cmp("file2", "file10"), std::cmp::Ordering::Less);
        assert_eq!(natural_cmp("B", "a"), std::cmp::Ordering::Greater);
    }

    #[test]
    fn known_folders_resolve() {
        crate::win::com::ensure_mta();
        assert!(known_folder(&windows::Win32::UI::Shell::FOLDERID_Recent).is_some());
    }
}
