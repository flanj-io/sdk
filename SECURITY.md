# Security Policy

## Reporting a Vulnerability

We take the security of Vinifera seriously — this project handles payment-adjacent
traffic and its whole reason for being is to keep sensitive data from leaking.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately via one of:

- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the **Security** tab), or
- email **security@vinifera.io**.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- affected version(s) / commit,
- any suggested mitigation.

We will acknowledge your report within **3 business days** and aim to provide a
remediation timeline within **10 business days**. We ask that you give us a
reasonable window to release a fix before any public disclosure, and we're happy
to credit you in the advisory unless you prefer to remain anonymous.

## Scope — a note on redaction

Because this project captures request/response bodies, **any path by which raw
PAN/PII can reach storage or the wire unredacted is a security issue** and is
in scope. If you find a redaction bypass, please report it privately as above.
