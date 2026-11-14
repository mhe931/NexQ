//! Minimal OLE Automation (IDispatch) late binding.
//!
//! Enough to drive Office's object model by name without type libraries,
//! admin rights or any extra dependency. All calls must run on the thread that
//! initialised COM (see `service`).

use std::mem::ManuallyDrop;

use windows::core::{Interface, BSTR, GUID, PCWSTR};
use windows::Win32::System::Com::{
    CLSIDFromProgID, CoInitializeEx, CoUninitialize, IDispatch, COINIT_APARTMENTTHREADED, DISPATCH_FLAGS,
    DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPPARAMS, EXCEPINFO,
};
use windows::Win32::System::Ole::GetActiveObject;
use windows::Win32::System::Variant::{
    VariantClear, VARIANT, VT_BOOL, VT_BSTR, VT_DISPATCH, VT_EMPTY, VT_I2, VT_I4,
};

const LOCALE_USER_DEFAULT: u32 = 0x0400;
const RPC_E_CALL_REJECTED: i32 = 0x8001_0001_u32 as i32;
const RPC_E_SERVERCALL_RETRYLATER: i32 = 0x8001_010A_u32 as i32;
const RPC_E_DISCONNECTED: i32 = 0x8001_0108_u32 as i32;
const RPC_E_SERVER_DIED: i32 = 0x8001_0007_u32 as i32;
const RPC_S_SERVER_UNAVAILABLE: i32 = 0x8007_06BA_u32 as i32;
const RPC_S_CALL_FAILED: i32 = 0x8007_06BE_u32 as i32;
const CO_E_OBJNOTCONNECTED: i32 = 0x8004_0004_u32 as i32;
const MK_E_UNAVAILABLE: i32 = 0x8004_01E3_u32 as i32;

#[derive(Debug, Clone, PartialEq)]
pub enum ComError {
    /// The server (or the object) is gone.
    Gone(String),
    /// The server is alive but refusing calls (a modal dialog is open, etc.).
    Busy(String),
    Other(String),
}

impl ComError {
    fn from_hresult(code: i32, context: &str) -> Self {
        match code {
            RPC_E_DISCONNECTED | RPC_E_SERVER_DIED | RPC_S_SERVER_UNAVAILABLE | RPC_S_CALL_FAILED
            | CO_E_OBJNOTCONNECTED | MK_E_UNAVAILABLE => Self::Gone(format!("{context}: the application is no longer reachable")),
            RPC_E_CALL_REJECTED | RPC_E_SERVERCALL_RETRYLATER => {
                Self::Busy(format!("{context}: the application is busy (close any open dialog)"))
            }
            other => Self::Other(format!("{context} failed (0x{:08X})", other as u32)),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Gone(m) | Self::Busy(m) | Self::Other(m) => m,
        }
    }
}

/// Initialises COM (apartment-threaded) for this thread and uninitialises on drop.
pub struct ComApartment {
    initialised: bool,
}

impl ComApartment {
    pub fn new() -> Self {
        // S_OK and S_FALSE both mean "usable"; a failure (e.g. a different mode
        // already set) just leaves it to the existing initialisation.
        let initialised = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };
        Self { initialised }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialised {
            unsafe { CoUninitialize() };
        }
    }
}

/// An owned VARIANT, cleared on drop.
pub struct Var(VARIANT);

impl Var {
    pub fn empty() -> Self {
        Var(VARIANT::default())
    }

    pub fn int(value: i32) -> Self {
        let mut v = VARIANT::default();
        unsafe {
            let inner = &mut *v.Anonymous.Anonymous;
            inner.vt = VT_I4;
            inner.Anonymous.lVal = value;
        }
        Var(v)
    }

    pub fn text(value: &str) -> Self {
        let mut v = VARIANT::default();
        unsafe {
            let inner = &mut *v.Anonymous.Anonymous;
            inner.vt = VT_BSTR;
            inner.Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(value));
        }
        Var(v)
    }

    fn vt(&self) -> u16 {
        unsafe { self.0.Anonymous.Anonymous.vt.0 }
    }

    pub fn as_i32(&self) -> Option<i32> {
        unsafe {
            let inner = &*self.0.Anonymous.Anonymous;
            match inner.vt {
                VT_I4 => Some(inner.Anonymous.lVal),
                VT_I2 => Some(i32::from(inner.Anonymous.iVal)),
                _ => None,
            }
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        unsafe {
            let inner = &*self.0.Anonymous.Anonymous;
            (inner.vt == VT_BOOL).then(|| inner.Anonymous.boolVal.0 != 0)
        }
    }

    pub fn as_string(&self) -> Option<String> {
        unsafe {
            let inner = &*self.0.Anonymous.Anonymous;
            (inner.vt == VT_BSTR).then(|| inner.Anonymous.bstrVal.to_string())
        }
    }

    pub fn into_dispatch(self) -> Option<Dispatch> {
        unsafe {
            let inner = &*self.0.Anonymous.Anonymous;
            if inner.vt == VT_DISPATCH {
                // Clone adds a reference; the original is released when `self` clears.
                (*inner.Anonymous.pdispVal).clone().map(Dispatch)
            } else {
                None
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.vt() == VT_EMPTY.0
    }
}

impl Drop for Var {
    fn drop(&mut self) {
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}

#[derive(Clone)]
pub struct Dispatch(IDispatch);

impl Dispatch {
    fn dispid(&self, name: &str) -> Result<i32, ComError> {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let names = [PCWSTR(wide.as_ptr())];
        let mut id = 0i32;
        unsafe {
            self.0
                .GetIDsOfNames(&GUID::zeroed(), names.as_ptr(), 1, LOCALE_USER_DEFAULT, &mut id)
                .map_err(|e| ComError::from_hresult(e.code().0, &format!("Looking up “{name}”")))?;
        }
        Ok(id)
    }

    fn invoke(&self, name: &str, flags: DISPATCH_FLAGS, args: &[Var]) -> Result<Var, ComError> {
        let id = self.dispid(name)?;
        // DISPPARAMS arguments are passed last-to-first.
        let mut raw: Vec<VARIANT> = args.iter().rev().map(|a| a.0.clone()).collect();
        let params = DISPPARAMS {
            rgvarg: if raw.is_empty() { std::ptr::null_mut() } else { raw.as_mut_ptr() },
            rgdispidNamedArgs: std::ptr::null_mut(),
            cArgs: raw.len() as u32,
            cNamedArgs: 0,
        };
        let mut result = VARIANT::default();
        let mut excep = EXCEPINFO::default();
        let mut arg_err = 0u32;
        let outcome = unsafe {
            self.0.Invoke(
                id,
                &GUID::zeroed(),
                LOCALE_USER_DEFAULT,
                flags,
                &params,
                Some(&mut result),
                Some(&mut excep),
                Some(&mut arg_err),
            )
        };
        // The cloned argument VARIANTs are shallow copies owned by `args`; do not clear them.
        drop(raw);
        match outcome {
            Ok(()) => Ok(Var(result)),
            Err(e) => {
                let code = if e.code().0 == 0x8002_0009_u32 as i32 && excep.scode != 0 { excep.scode } else { e.code().0 };
                Err(ComError::from_hresult(code, &format!("“{name}”")))
            }
        }
    }

    /// Property read, or a zero-argument method that behaves like one.
    pub fn get(&self, name: &str) -> Result<Var, ComError> {
        self.invoke(name, DISPATCH_PROPERTYGET | DISPATCH_METHOD, &[])
    }

    /// Method call (also covers indexed collection access such as `Item(1)`).
    pub fn call(&self, name: &str, args: &[Var]) -> Result<Var, ComError> {
        self.invoke(name, DISPATCH_METHOD | DISPATCH_PROPERTYGET, args)
    }

    pub fn get_dispatch(&self, name: &str) -> Result<Dispatch, ComError> {
        self.get(name)?
            .into_dispatch()
            .ok_or_else(|| ComError::Other(format!("“{name}” is not an object")))
    }

    pub fn get_i32(&self, name: &str) -> Result<i32, ComError> {
        self.get(name)?.as_i32().ok_or_else(|| ComError::Other(format!("“{name}” is not a number")))
    }

    pub fn get_string(&self, name: &str) -> Result<String, ComError> {
        self.get(name)?.as_string().ok_or_else(|| ComError::Other(format!("“{name}” is not text")))
    }

    /// `collection.Item(index)` for a 1-based COM index.
    pub fn item(&self, index: i32) -> Result<Dispatch, ComError> {
        self.call("Item", &[Var::int(index)])?
            .into_dispatch()
            .ok_or_else(|| ComError::Other("collection item is not an object".into()))
    }
}

/// The running instance of `prog_id` (for example `PowerPoint.Application`),
/// or `Ok(None)` when it is not running. Never starts the application.
pub fn running_object(prog_id: &str) -> Result<Option<Dispatch>, ComError> {
    let wide: Vec<u16> = prog_id.encode_utf16().chain(Some(0)).collect();
    let clsid = unsafe { CLSIDFromProgID(PCWSTR(wide.as_ptr())) }
        .map_err(|_| ComError::Other(format!("{prog_id} is not installed")))?;
    let mut unknown = None;
    match unsafe { GetActiveObject(&clsid, None, &mut unknown) } {
        Ok(()) => match unknown {
            Some(u) => u
                .cast::<IDispatch>()
                .map(|d| Some(Dispatch(d)))
                .map_err(|e| ComError::from_hresult(e.code().0, prog_id)),
            None => Ok(None),
        },
        Err(e) if e.code().0 == MK_E_UNAVAILABLE => Ok(None),
        Err(e) => Err(ComError::from_hresult(e.code().0, prog_id)),
    }
}
