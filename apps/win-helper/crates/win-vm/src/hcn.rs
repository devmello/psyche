//! The opt-in NAT network (`computenetwork.dll`, HNS schema 2): one `NAT` network per owner
//! (`PsycheVM-<sid hash>`, a /24 in 172.31.240.0/20 picked from the owner hash) and one endpoint
//! per running guest, attached as the guest's only network adapter. Never bridged to the LAN.
//! The guest reads its address from `/mnt/psyche/psyche-meta/network.json`.

use std::ffi::c_void;

use serde_json::{Value, json};
use windows::Win32::Foundation::{FreeLibrary, HMODULE};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW};
use windows::core::{GUID, HRESULT, HSTRING, PCSTR, PCWSTR, PWSTR};

use crate::error::{VmError, VmResult};

type Handle = *mut c_void;
type FnOpenNetwork = unsafe extern "system" fn(*const GUID, *mut Handle, *mut PWSTR) -> HRESULT;
type FnCreateNetwork = unsafe extern "system" fn(*const GUID, PCWSTR, *mut Handle, *mut PWSTR) -> HRESULT;
type FnClose = unsafe extern "system" fn(Handle) -> HRESULT;
type FnCreateEndpoint = unsafe extern "system" fn(Handle, *const GUID, PCWSTR, *mut Handle, *mut PWSTR) -> HRESULT;
type FnQueryEndpoint = unsafe extern "system" fn(Handle, PCWSTR, *mut PWSTR, *mut PWSTR) -> HRESULT;
type FnDeleteEndpoint = unsafe extern "system" fn(*const GUID, *mut PWSTR) -> HRESULT;

pub struct Hcn {
    lib: HMODULE,
    open_network: FnOpenNetwork,
    create_network: FnCreateNetwork,
    close_network: FnClose,
    create_endpoint: FnCreateEndpoint,
    query_endpoint: FnQueryEndpoint,
    close_endpoint: FnClose,
    delete_endpoint: FnDeleteEndpoint,
}

// SAFETY: process-global function pointers.
unsafe impl Send for Hcn {}
// SAFETY: as above.
unsafe impl Sync for Hcn {}

impl Drop for Hcn {
    fn drop(&mut self) {
        // SAFETY: releases the module loaded by `load`.
        unsafe {
            let _ = FreeLibrary(self.lib);
        }
    }
}

fn take(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: HNS strings are CoTaskMemAlloc'd and NUL-terminated.
    unsafe {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const c_void));
        s
    }
}

fn err(what: &str, hr: HRESULT, record: &str) -> VmError {
    let code = hr.0 as u32;
    VmError::unavailable("nat_unavailable", format!("{what} failed (0x{code:08X}) {}", record.chars().take(300).collect::<String>()))
        .detail("hresult", format!("0x{code:08X}"))
}

/// The owner's network id, subnet and name (deterministic from the SID).
pub fn network_plan(owner_sid: &str) -> (GUID, String, String, String) {
    let h = crate::paths::sha256_hex(format!("psyche-nat:{owner_sid}").as_bytes());
    let id = GUID::from_u128(u128::from_str_radix(&h[..32], 16).unwrap_or(1));
    let k = 240 + (u8::from_str_radix(&h[32..34], 16).unwrap_or(0) % 16) as u32;
    (id, format!("172.31.{k}.0/24"), format!("172.31.{k}.1"), format!("PsycheVM-{}", &h[..12]))
}

pub fn network_settings(name: &str, prefix: &str, gateway: &str) -> Value {
    json!({
        "SchemaVersion": {"Major": 2, "Minor": 0},
        "Name": name,
        "Type": "NAT",
        "Flags": 0,
        "Ipams": [{"Type": "Static", "Subnets": [{"IpAddressPrefix": prefix, "Routes": [{"NextHop": gateway, "DestinationPrefix": "0.0.0.0/0"}]}]}],
    })
}

pub fn endpoint_settings(network: &GUID, mac: &str) -> Value {
    json!({
        "SchemaVersion": {"Major": 2, "Minor": 0},
        "HostComputeNetwork": format!("{network:?}"),
        "MacAddress": crate::hcs::doc::hcs_mac(mac),
        "Policies": [],
    })
}

/// `network.json` for the guest from the endpoint's properties.
pub fn guest_network(props: &Value, gateway: &str) -> Value {
    let ip = &props["IpConfigurations"][0];
    json!({
        "mode": "nat",
        "address": ip["IpAddress"],
        "prefixLength": ip["PrefixLength"].as_u64().unwrap_or(24),
        "gateway": props["Routes"][0]["NextHop"].as_str().unwrap_or(gateway),
        "dns": props["Dns"]["ServerList"].as_array().cloned().unwrap_or_else(|| vec![Value::String(gateway.to_owned())]),
    })
}

macro_rules! sym {
    ($lib:expr, $name:literal, $ty:ty) => {{
        // SAFETY: the symbol has the documented signature of the type it is cast to.
        match unsafe { GetProcAddress($lib, PCSTR(concat!($name, "\0").as_ptr())) } {
            Some(f) => unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(f) },
            None => return Err(VmError::unavailable("nat_unavailable", concat!("computenetwork.dll has no ", $name))),
        }
    }};
}

pub struct Endpoint {
    pub id: GUID,
    pub guest: Value,
}

impl Hcn {
    pub fn load() -> VmResult<Hcn> {
        // SAFETY: a System32 DLL.
        let lib = unsafe { LoadLibraryExW(&HSTRING::from("computenetwork.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }
            .map_err(|_| VmError::unavailable("nat_unavailable", "The Host Network Service is not installed"))?;
        Ok(Hcn {
            lib,
            open_network: sym!(lib, "HcnOpenNetwork", FnOpenNetwork),
            create_network: sym!(lib, "HcnCreateNetwork", FnCreateNetwork),
            close_network: sym!(lib, "HcnCloseNetwork", FnClose),
            create_endpoint: sym!(lib, "HcnCreateEndpoint", FnCreateEndpoint),
            query_endpoint: sym!(lib, "HcnQueryEndpointProperties", FnQueryEndpoint),
            close_endpoint: sym!(lib, "HcnCloseEndpoint", FnClose),
            delete_endpoint: sym!(lib, "HcnDeleteEndpoint", FnDeleteEndpoint),
        })
    }

    /// Opens (or creates) the owner's NAT network and adds an endpoint with `mac`.
    pub fn create_endpoint(&self, owner_sid: &str, mac: &str) -> VmResult<Endpoint> {
        let (net_id, prefix, gateway, name) = network_plan(owner_sid);
        let mut net: Handle = std::ptr::null_mut();
        let mut record = PWSTR::null();
        // SAFETY: plain calls with out parameters; strings freed by `take`, handles closed below.
        unsafe {
            let hr = (self.open_network)(&net_id, &mut net, &mut record);
            take(record);
            if hr.is_err() {
                let settings = HSTRING::from(network_settings(&name, &prefix, &gateway).to_string());
                let mut record = PWSTR::null();
                let hr = (self.create_network)(&net_id, PCWSTR(settings.as_ptr()), &mut net, &mut record);
                let r = take(record);
                if hr.is_err() {
                    return Err(err("Creating the NAT network", hr, &r));
                }
            }
            let ep_id = GUID::from_u128(u128::from_le_bytes(crate::model::random_bytes::<16>()));
            let settings = HSTRING::from(endpoint_settings(&net_id, mac).to_string());
            let mut ep: Handle = std::ptr::null_mut();
            let mut record = PWSTR::null();
            let hr = (self.create_endpoint)(net, &ep_id, PCWSTR(settings.as_ptr()), &mut ep, &mut record);
            let r = take(record);
            let _ = (self.close_network)(net);
            if hr.is_err() {
                return Err(err("Creating the NAT endpoint", hr, &r));
            }
            let mut props = PWSTR::null();
            let mut record = PWSTR::null();
            let q = HSTRING::from("{}");
            let hr = (self.query_endpoint)(ep, PCWSTR(q.as_ptr()), &mut props, &mut record);
            let p = take(props);
            take(record);
            let _ = (self.close_endpoint)(ep);
            let props: Value = if hr.is_ok() { serde_json::from_str(&p).unwrap_or(Value::Null) } else { Value::Null };
            Ok(Endpoint { id: ep_id, guest: guest_network(&props, &gateway) })
        }
    }

    pub fn delete_endpoint(&self, id: &GUID) {
        let mut record = PWSTR::null();
        // SAFETY: plain call; the record string is freed.
        unsafe {
            let _ = (self.delete_endpoint)(id, &mut record);
            take(record);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_and_documents() {
        let (id, prefix, gw, name) = network_plan("S-1-5-21-1-2-3-1001");
        assert_eq!(network_plan("S-1-5-21-1-2-3-1001").0, id, "deterministic");
        assert_ne!(network_plan("S-1-5-21-1-2-3-1002").0, id);
        assert!(prefix.starts_with("172.31.") && prefix.ends_with(".0/24"));
        assert!(gw.ends_with(".1") && name.starts_with("PsycheVM-"));
        let n = network_settings(&name, &prefix, &gw);
        assert_eq!(n["Type"], "NAT");
        assert_eq!(n["Ipams"][0]["Subnets"][0]["Routes"][0]["NextHop"], gw);
        let e = endpoint_settings(&id, "00:15:5d:00:00:01");
        assert_eq!(e["MacAddress"], "00-15-5D-00-00-01");
        let g = guest_network(&json!({"IpConfigurations": [{"IpAddress": "172.31.241.5", "PrefixLength": 24}]}), &gw);
        assert_eq!(g["address"], "172.31.241.5");
        assert_eq!(g["dns"][0], gw);
    }
}
