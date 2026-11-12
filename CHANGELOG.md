# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Meta webhook verification in every workflow: a `GET` webhook on the same path as each
  `POST` webhook answers `hub.challenge` when `hub.verify_token` matches, and returns
  403 otherwise. Previously the URLs could not be subscribed without extra work.
- Unit tests for Code node logic (`test/`, `node --test`): normalisation, ORDER_DATA
  parsing, handover detection, follow-up filtering and human takeover.
- Validator checks that Code node JavaScript compiles and that each `POST` webhook has
  a `GET` verification twin. CI runs the tests.

### Fixed
- E-commerce bot: `Normalize Message` read the webhook item instead of its `body`, and
  matched WhatsApp payloads as Messenger because both contain `entry`. It now reads
  `body`, checks WhatsApp first, and stops on echoes, receipts and status updates
  instead of sending them to the model.
- Follow-up filters no longer crash the whole scheduled run when an `order_state`
  cell holds invalid JSON.
