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

## [Unreleased]

Replaced the boolean `isBounce` Kafka field with `inboundType` (`DSN` / `MDN` / `AUTO_REPLY` / `AUTO_GENERATED` / `NORMAL`) and an RFC 3463 `bounceStatus` code so downstream can distinguish soft, hard, and success delivery-status reports. DSN detection now reads the null envelope sender directly (dropping the `haraka-plugin-bounce` dependency) and parses the `Status:` field from the `message/delivery-status` part; body parsing is enabled on the `data` hook. Bump `messageVersion` before deploying.