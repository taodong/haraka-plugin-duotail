[![CI](https://github.com/taodong/haraka-plugin-duotail/actions/workflows/ci.yml/badge.svg)](https://github.com/taodong/haraka-plugin-duotail/actions/workflows/ci.yml)


# haraka-plugin-duotail

Haraka plugin for Duotail project. It routes the incoming email to a Hazelcast cache and sends a summary to a Kafka topic

## Dependency

For production environment, the following plugins are needed before this plugin:

- [mailauth](https://github.com/haraka/haraka-plugin-mailauth) — provides the SPF/DKIM results this plugin reads.

## Inbound message classification

Each queued message is classified into an `inboundType` and, for delivery-status reports, an RFC 3463 `bounceStatus` code. Rules are evaluated in order; the first match wins:

| `inboundType` | Detected by | `bounceStatus` |
| --- | --- | --- |
| `DSN` | null envelope `MAIL FROM` **and** a `message/delivery-status` MIME part | RFC 3463 `Status:` code (`2.x.x` delivered, `4.x.x` soft bounce, `5.x.x` hard bounce), or `null` if unparseable |
| `MDN` | a `message/disposition-notification` MIME part (read receipt) | `null` |
| `AUTO_REPLY` | `Auto-Submitted: auto-replied`, or `X-Autoreply` / `X-Autorespond` | `null` |
| `AUTO_GENERATED` | `Auto-Submitted: auto-generated`, or `Precedence: bulk`/`list`/`junk` | `null` |
| `NORMAL` | none of the above | `null` |

The null-sender check reads the envelope address directly, so `haraka-plugin-bounce` is no longer required. Body parsing is enabled on the `data` hook so the report parts are available at queue time.

## Sender fields

Besides the envelope sender (`mailFrom`), the Kafka summary carries two sender fields:

| Field | Value |
| --- | --- |
| `headerFrom` | The first mailbox of the `From` header, built with `address-rfc2821` exactly like `mailFrom` (`original`, `original_host`, `host`, `user`, plus `is_utf8` for internationalized addresses), or `null` when the header is missing, unparseable, not a valid RFC 5321 mailbox, or repeated (a message with more than one `From` header). The address is taken verbatim from the header, so a quoted local part keeps its quotes in `original` and `user`. A group's first member counts as its mailbox. |
| `dkimDomains` | The lower-cased, de-duplicated `d=` domains of every DKIM signature that verified, or `[]`. `dkimCheck` stays `pass` when any of them passed. |

Both fields are additive. Consumers that don't know them ignore them.

When the Kafka message schema changes (for example, replacing `isBounce` with `inboundType`/`bounceStatus`), bump `messageVersion` in `config/duotail.ini` so downstream consumers can safely branch on the schema version.

## De-duplication

A remote server may deliver one email over several SMTP transactions with the same `Message-ID`: Gmail sends a reply-all with one recipient per transaction, on parallel connections, and any server may repeat a delivery. Each envelope recipient is therefore claimed once, with an atomic `putIfAbsent` of `<Message-ID>|<recipient>` (recipient lower-cased) in the `emailIdCacheMapName` map:

- recipients no earlier transaction claimed are forwarded; the summary's `rcptTo` holds only those, so it may be a subset of the transaction's envelope;
- a transaction whose recipients were all claimed before is dropped (answered `250`, as before);
- a message without `Message-ID` is forwarded without de-duplication.

Claims expire with the map's `time-to-live-seconds`, which is set on the Hazelcast **member**, not by this plugin (Duotail uses 120 s).

The summary is published to Kafka only after the message is in the cache. If caching or publishing fails, the plugin removes the claims this transaction made and answers `DENYSOFT` (`451 Temporary failure, please retry`) at once, so the sender's retry is processed.

## INSTALL

```sh
cd /path/to/local/haraka
npm install haraka-plugin-duotail
echo "duotail" >> config/plugins
service haraka restart
```

### Configuration

Copy the config file from the distribution into your haraka config dir and then modify it:

```sh
cp node_modules/haraka-plugin-duotail/config/duotail.ini config/duotail.ini
$EDITOR config/duotail.ini
```

<!-- leave these buried at the bottom of the document -->

[ci-img]: https://github.com/taodong/hakara-plugin-duotail/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/taodong/hakara-plugin-duotail/actions/workflows/ci.yml
[npm-img]: https://nodei.co/npm/haraka-plugin-duotail.png
[npm-url]: https://www.npmjs.com/package/haraka-plugin-duotail
