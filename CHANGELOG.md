# Changelog

Change log for duotail harak plugin

## [1.0.0] - 2025-02-07

Initial release

## [1.0.1] - 2025-03-28

Removed `jslint` from dependency
Removed Changes.md file 
Fixed non stop test issue
Added Hazelcast client reconnect logic
Added condition check in shutdown logic

## [1.0.2] - 2025-07-11

Set incoming email header 'Message-ID' value as 'incomingId' in Kafka payload

## [1.0.3] - 2025-12-22

Fix double sending issue of remote mail server sending email through multiple connections

## [1.1.0] - 2026-08-13

Replaced the boolean `isBounce` Kafka field with `inboundType` (`DSN` / `MDN` / `AUTO_REPLY` / `AUTO_GENERATED` / `NORMAL`) and an RFC 3463 `bounceStatus` code so downstream can distinguish soft, hard, and success delivery-status reports. DSN detection now reads the null envelope sender directly (dropping the `haraka-plugin-bounce` dependency) and parses the `Status:` field from the `message/delivery-status` part; body parsing is enabled on the `data` hook. Bump `messageVersion` before deploying.

## [1.2.0] - 2026-10-15

Added `headerFrom` (first mailbox of the `From` header, built with `address-rfc2821` like `mailFrom`, keeping quoted local parts verbatim) and `dkimDomains` (the `d=` domains of every passing DKIM signature) to the Kafka payload. Both fields are additive and optional for consumers. A message with more than one `From` header yields `headerFrom: null`, because DKIM covers only the bottom-most `From`.

## [1.3.0] - 2026-10-28

De-duplication is per recipient: each envelope recipient is claimed once with an atomic `putIfAbsent` of `<Message-ID>|<recipient>`, instead of dropping every transaction whose `Message-ID` was seen. A split delivery (Gmail sends a reply-all with one recipient per transaction) now forwards every recipient; a repeated delivery is still dropped; `rcptTo` in the summary holds only the recipients this transaction claimed. The summary is published only after the message is cached. A Hazelcast or Kafka failure removes this transaction's claims and answers `DENYSOFT`, instead of leaving the transaction to Haraka's plugin timeout (Hazelcast) or answering `250` and losing the email (Kafka). Added `headerRecipients` (the `To` and `Cc` mailboxes, built like `headerFrom`), so downstream can tell a split reply-all from a plain reply without loading the cached message. The field is additive, so `messageVersion` does not change.
