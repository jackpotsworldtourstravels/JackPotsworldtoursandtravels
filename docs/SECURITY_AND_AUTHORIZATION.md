# Security and Authorization

JackpotsWorld Tours & Travels. Written 8 October 2026.

**How this was checked.** Every statement below was read from the backend code and the front-end token storage. Nothing was run, and server or proxy settings were not inspected. A statement marked *Not found* means a keyword search of `backend/app` found nothing, so a feature under a different name could be missed. Label used: **Verified from Code**.

---

## 1. Authentication (who you are)

### Customer portal
- **Email OTP sign-in, no password.** Verified from Code (`routers/customer_auth.py`, `services/customer_otp_service.py`).
- **Google sign-in** is an additional method beside OTP. The server verifies Google's ID token: issuer, audience, expiry and signature. A new Google user finishes sign-up with a mobile number within 20 minutes (`google_pending_signup_ttl_minutes`). Verified from Code (`customer_google_auth_service.py`, `config.py`).
- **Guest sessions** can be started anonymously and return the same token pair. Verified from Code.
- **Blocked customers** are refused at login. Verified from Code.

### Staff, merchant and partner portals
- Password login. Passwords are hashed with **bcrypt** (`auth/security.py`). Verified from Code.
- Failed logins are counted (`failed_login_attempts`) and written to a log. Verified from Code.
- Blocked accounts are refused at login. Verified from Code.

### OTP rules
| Rule | Value |
|---|---|
| Length | 6 digits |
| Valid for | 5 minutes |
| Codes per hour | 5 |
| Wrong tries per code | 5, then the code is dead |
| Storage | SHA-256 hash, never in clear |
| Comparison | `hmac.compare_digest` (timing-safe) |

Verified from Code. In local development the OTP can be echoed in the API (`otp_dev_echo`); when `DEPLOYED=true` this is blocked and the code is emailed.

---

## 2. Tokens and sessions

- **JWT**, signed with `jwt_secret_key`. Verified from Code (`auth/security.py`).
- **Access token: 30 minutes. Refresh token: 7 days.** Password-reset token: 60 minutes (`config.py`).
- **Scoped tokens.** Each token carries a `scope` claim, and each login area accepts only its own:

| Scope claim | Used for | Accepted by |
|---|---|---|
| none | merchant and admin | `auth/deps.py` |
| `customer` | Customer Portal | `auth/customer_deps.py` only |
| `partner` | Partner Portal | partner dependencies |
| `super_admin` | Super Admin Portal | super-admin dependencies |
| `customer_otp_challenge` | mid-login step | the OTP verify step only |
| `otp_challenge` | mid-login (staff) | the OTP verify step only |

  This stops, for example, a merchant refresh token from creating a customer session for a matching id. Verified from Code.
- **Force logout.** A `force_logout_at` time on the user cancels every token issued before it. Verified from Code.
- **Refresh.** Refreshing returns a new token pair. The old refresh token is **not** blacklisted, so it stays valid until it expires or force logout is used. Verified from Code.
- **Browser storage.** Tokens are kept in `localStorage` (`frontend/assets/js/auth.js`). This is exposed if the site suffers an XSS attack. Verified from Code.

---

## 3. Authorization (what you may do)

Single source of truth: `backend/app/auth/rbac.py`. Every protected endpoint declares a permission code, and this module decides. Routers do not re-derive rules from `user.role`.

### Roles
| Role | Can do | Cannot do |
|---|---|---|
| `super_admin` | manages Admins | raise tickets. Not an "all access" account. |
| `admin` | manages Merchants, approves tickets, handles payments | |
| `merchant_admin`, `merchant_user` | raise and track their own requests | see another merchant's data |

### How permissions are worked out
A user's permissions are the union of:
1. defaults for their portal role,
2. defaults for their merchant sub-role, if any,
3. extra permission codes saved on the user (`users.permissions`).

Every merchant account holds the read set `_MERCHANT_READ`. A merchant sub-role only adds action permissions, so it changes which buttons work, never which screens exist.

Verified from Code. Explicit endpoint checks use `require_permission(code)` in `auth/deps.py`.

---

## 4. Brute-force and abuse protection

- **Per-IP rate limits** with `slowapi`: 5 to 20 requests a minute on login, OTP and refresh routes. Verified from Code.
- **OTP limits** as in section 1. Verified from Code.
- **Account lockout:** *Not found.* Failed attempts are counted but nothing locks the account.
- **Bot check (Turnstile or CAPTCHA):** *Not found.*
- **Idle timeout:** *Not found* on the server or in the front-end code.

---

## 5. Transport and response headers

- Set in `backend/app/main.py`: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`. HTML responses use `Cache-Control: no-store`. Verified from Code.
- CORS allows only the origins in `cors_origins`. Verified from Code.
- **HSTS:** *Not found* in the backend. It may be set by the server or proxy in front, which was not checked.

---

## 6. Known gaps (most important first)

1. No account lockout for staff and partner password logins.
2. No 2FA or IP allowlist for the super admin account.
3. No bot check on login and OTP requests, so bots can trigger OTP emails.
4. Refresh tokens are not one-time use. A stolen one works for up to 7 days.
5. No idle timeout. Sessions end only when the token expires.
6. HSTS not found in the backend. Confirm it at the server in front.
7. Tokens stored in `localStorage` (XSS exposure).

Suggested order: lockout, super-admin 2FA and IP allowlist, Turnstile, one-time refresh tokens, then idle timeout and HSTS.
