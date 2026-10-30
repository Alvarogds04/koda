//! #489 the real HTTP behind the [`Http`] seam: https (n8n may be loopback http, validated by its
//! poller), no redirects, 10 s, body capped at 1 MiB, no cookies. GET/POST/PUT/PATCH only.
//! Linux only for now; elsewhere every call answers `unsupported`.
use crate::integrations::{Http, NetError, Response};

pub struct Net;

#[cfg(target_os = "linux")]
impl Http for Net {
    fn send(&self, method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Response, NetError> {
        use std::str::FromStr;
        const MAX_BODY: usize = 1024 * 1024;
        let method = match method {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            "PATCH" => reqwest::Method::PATCH,
            _ => return Err(NetError("method".into())),
        };
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| NetError("client".into()))?;
        let mut request = client.request(method, url);
        if let Some(b) = body {
            request = request.body(b.to_string());
        }
        for (name, value) in headers {
            let name = reqwest::header::HeaderName::from_str(name).map_err(|_| NetError("header".into()))?;
            let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| NetError("header".into()))?;
            request = request.header(name, value);
        }
        tauri::async_runtime::block_on(async move {
            let mut response = request.send().await.map_err(|_| NetError("request".into()))?;
            let status = response.status().as_u16();
            let mut out = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| NetError("body".into()))? {
                if out.len() + chunk.len() > MAX_BODY {
                    return Err(NetError("too large".into()));
                }
                out.extend_from_slice(&chunk);
            }
            Ok(Response { status, body: String::from_utf8_lossy(&out).into_owned() })
        })
    }
}

#[cfg(not(target_os = "linux"))]
impl Http for Net {
    fn send(&self, _: &str, _: &str, _: &[(&str, &str)], _: Option<&str>) -> Result<Response, NetError> {
        Err(NetError("unsupported".into()))
    }
}
