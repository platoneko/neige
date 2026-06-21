use std::net::IpAddr;

pub fn is_allowed_origin(origin: &str, allowed: &[String]) -> bool {
    if origin.is_empty() || origin == "null" {
        return false;
    }
    let Ok(u) = url::Url::parse(origin) else {
        return false;
    };
    if !matches!(u.scheme(), "http" | "https") {
        return false;
    }
    match u.host_str() {
        Some("localhost" | "127.0.0.1" | "::1" | "[::1]") => return true,
        Some(_) => {}
        None => return false,
    }
    let norm = origin.trim_end_matches('/');
    allowed
        .iter()
        .any(|a| a.trim_end_matches('/').eq_ignore_ascii_case(norm))
}

/// Extract "scheme://host[:port]" from a Referer URL, for fallback checks.
pub fn origin_from_referer(referer: &str) -> Option<String> {
    let u = url::Url::parse(referer).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?;
    let origin = match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    };
    Some(origin)
}

/// Like [`is_allowed_origin`] but also accepts any http(s) origin whose host is
/// an IP literal inside one of the given CIDR blocks (e.g. `10.8.0.0/24` for a
/// WireGuard subnet). Lets a whole private subnet be trusted without
/// enumerating every host address. Only IP-literal origins can match a CIDR —
/// hostnames never do, even if they would resolve into the range.
pub fn is_allowed_origin_with_cidrs(origin: &str, allowed: &[String], cidrs: &[String]) -> bool {
    if is_allowed_origin(origin, allowed) {
        return true;
    }
    if cidrs.is_empty() {
        return false;
    }
    let Some(ip) = origin_host_ip(origin) else {
        return false;
    };
    cidrs.iter().any(|c| ip_in_cidr(ip, c))
}

/// Parse the host of an http(s) origin as an IP literal, if it is one.
fn origin_host_ip(origin: &str) -> Option<IpAddr> {
    let u = url::Url::parse(origin).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?;
    // url strips brackets from IPv6 hosts, but be defensive either way.
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

/// True if `ip` is inside the CIDR block `cidr` (e.g. "10.8.0.0/24"). Supports
/// IPv4 and IPv6; returns false on malformed input or mismatched address family.
fn ip_in_cidr(ip: IpAddr, cidr: &str) -> bool {
    let Some((net_str, prefix_str)) = cidr.split_once('/') else {
        return false;
    };
    let Ok(prefix) = prefix_str.parse::<u32>() else {
        return false;
    };
    let Ok(net) = net_str.parse::<IpAddr>() else {
        return false;
    };
    match (ip, net) {
        (IpAddr::V4(ip), IpAddr::V4(net)) => {
            if prefix > 32 {
                return false;
            }
            if prefix == 0 {
                return true;
            }
            let mask = u32::MAX << (32 - prefix);
            (u32::from(ip) & mask) == (u32::from(net) & mask)
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) => {
            if prefix > 128 {
                return false;
            }
            if prefix == 0 {
                return true;
            }
            let mask = u128::MAX << (128 - prefix);
            (u128::from(ip) & mask) == (u128::from(net) & mask)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_allowed_any_port() {
        assert!(is_allowed_origin("http://localhost:3030", &[]));
        assert!(is_allowed_origin("http://127.0.0.1:8080", &[]));
        assert!(is_allowed_origin("http://[::1]:9000", &[]));
    }

    #[test]
    fn other_host_rejected_unless_allowed() {
        assert!(!is_allowed_origin("http://evil.com", &[]));
        assert!(is_allowed_origin(
            "https://ok.example.com",
            &["https://ok.example.com".into()]
        ));
    }

    #[test]
    fn null_origin_rejected() {
        assert!(!is_allowed_origin("null", &[]));
        assert!(!is_allowed_origin("", &[]));
    }

    #[test]
    fn substring_attack_rejected() {
        assert!(!is_allowed_origin("http://localhost.evil.com", &[]));
    }

    #[test]
    fn exotic_scheme_rejected() {
        assert!(!is_allowed_origin("ftp://localhost", &[]));
        assert!(!is_allowed_origin("file:///etc/passwd", &[]));
    }

    #[test]
    fn cidr_allows_host_in_subnet_any_port() {
        let cidrs = vec!["10.8.0.0/24".to_string()];
        assert!(is_allowed_origin_with_cidrs("http://10.8.0.2:3131", &[], &cidrs));
        assert!(is_allowed_origin_with_cidrs("http://10.8.0.99:3131", &[], &cidrs));
        assert!(is_allowed_origin_with_cidrs("http://10.8.0.2", &[], &cidrs));
    }

    #[test]
    fn cidr_rejects_host_outside_subnet() {
        let cidrs = vec!["10.8.0.0/24".to_string()];
        assert!(!is_allowed_origin_with_cidrs("http://10.8.1.2:3131", &[], &cidrs));
        assert!(!is_allowed_origin_with_cidrs("http://192.168.5.20:3131", &[], &cidrs));
        assert!(!is_allowed_origin_with_cidrs("http://10.9.0.2:3131", &[], &cidrs));
    }

    #[test]
    fn cidr_never_matches_hostname_origins() {
        // A DNS name is never treated as in-range, even if it looks IP-ish or
        // would resolve into the block. Only IP-literal hosts can match.
        let cidrs = vec!["10.8.0.0/24".to_string()];
        assert!(!is_allowed_origin_with_cidrs("http://evil.example", &[], &cidrs));
        assert!(!is_allowed_origin_with_cidrs("http://10.8.0.2.evil.com", &[], &cidrs));
    }

    #[test]
    fn cidr_empty_falls_back_to_exact_and_loopback() {
        assert!(!is_allowed_origin_with_cidrs("http://10.8.0.2:3131", &[], &[]));
        assert!(is_allowed_origin_with_cidrs("http://127.0.0.1:8080", &[], &[]));
        assert!(is_allowed_origin_with_cidrs(
            "https://ok.example.com",
            &["https://ok.example.com".into()],
            &["10.8.0.0/24".into()],
        ));
    }

    #[test]
    fn cidr_ipv6_prefix() {
        let cidrs = vec!["fd00::/8".to_string()];
        assert!(is_allowed_origin_with_cidrs("http://[fd00::1]:3131", &[], &cidrs));
        assert!(!is_allowed_origin_with_cidrs("http://[fe80::1]:3131", &[], &cidrs));
    }

    #[test]
    fn cidr_malformed_rejected_without_panic() {
        let cidrs = vec!["not-a-cidr".to_string(), "10.8.0.0/99".to_string()];
        assert!(!is_allowed_origin_with_cidrs("http://10.8.0.2:3131", &[], &cidrs));
    }
}
