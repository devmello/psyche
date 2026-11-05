//! DPAPI (`CryptProtectData` / `CryptUnprotectData`), CurrentUser scope.

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};
use windows::core::HSTRING;

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    // SAFETY: DPAPI returned a LocalAlloc'd buffer of cbData bytes, freed right after the copy.
    unsafe {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        v
    }
}

pub fn protect(plain: &[u8], entropy: &[u8], description: &str) -> windows::core::Result<Vec<u8>> {
    let input = blob(plain);
    let ent = blob(entropy);
    let mut out = CRYPT_INTEGER_BLOB::default();
    let desc = HSTRING::from(description);
    // SAFETY: all blobs point at live buffers for the duration of the call.
    unsafe {
        CryptProtectData(
            &input,
            &desc,
            Some(&ent),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )?
    };
    Ok(take(out))
}

pub fn unprotect(sealed: &[u8], entropy: &[u8]) -> windows::core::Result<Vec<u8>> {
    let input = blob(sealed);
    let ent = blob(entropy);
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as above.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            Some(&ent),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )?
    };
    Ok(take(out))
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip_and_entropy_binding() {
        let sealed = super::protect(b"secret", b"e1", "test").unwrap();
        assert_ne!(sealed, b"secret");
        assert_eq!(super::unprotect(&sealed, b"e1").unwrap(), b"secret");
        assert!(super::unprotect(&sealed, b"e2").is_err());
    }
}
