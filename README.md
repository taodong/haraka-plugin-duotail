[![CI](https://github.com/taodong/haraka-plugin-duotail/actions/workflows/ci.yml/badge.svg)](https://github.com/taodong/haraka-plugin-duotail/actions/workflows/ci.yml)


# haraka-plugin-duotail

Haraka plugin for Duotail project. It routes the incoming email to a Hazelcast cache and sends a summary to a Kafka topic

## Dependency

For production environment, the following plugins are needed before this plugin:

- [mailauth](https://github.com/haraka/haraka-plugin-mailauth) — provides the SPF, DKIM and DMARC results this plugin reads. It must be listed before `duotail` in `config/plugins`.

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
| `dmarc` | The DMARC result, below, or `null`. |

## DMARC

`dmarc` is `null` when mailauth's DMARC step did not run (DKIM verification threw), threw, or saw no `From` address or more than one. Otherwise it is:

| Field | Value |
| --- | --- |
| `result` | `pass`, `fail`, `none` (no DMARC record) or `temperror` (the lookup failed) |
| `domain` | The organizational domain of the header `From` domain |
| `policy` | The effective policy (`sp` for a subdomain covered by the organizational record, else `p`), or `null` for `none` and `temperror` |
| `dkimAligned` | The passing DKIM `d=` domain that aligns with the header `From`, or `null` |
| `spfAligned` | The envelope `MAIL FROM` domain when SPF passed and it aligns with the header `From`, or `null` |

For `pass` and `fail`, alignment is mailauth's. For `none` and `temperror` mailauth computes none, so the plugin computes relaxed alignment itself with mailauth's `getAlignment`, from the same inputs. `mailauth` is pinned, because `mailauth/lib/tools` is not a documented entry point: re-run the tests on every upgrade. Strict alignment (`adkim=s`, `aspf=s`) is treated as relaxed, as mailauth 4.7.2 does.

### Refusing unaligned mail

With `rejectUnaligned = true` in the `[auth]` section, the `queue` hook refuses mail with no aligned domain before it is cached or published, so the sender's own server returns the bounce:

| Case | Reply |
| --- | --- |
| `dkimAligned` or `spfAligned` set | Continue |
| `DSN` or `AUTO_REPLY` to a `0_` recipient | Continue (the collector handles these without the sender check) |
| `fail` or `none`, not aligned | `550 5.7.26 Message not accepted: the From domain <domain> is not aligned with SPF or DKIM (DMARC)` |
| `temperror`, not aligned | `450 4.7.0 Sender authentication temporarily unavailable, try again later` |
| DMARC returned `false` (no `From`, or several `From` addresses) | `550 5.7.1 Message not accepted: exactly one From header is required` |
| A DMARC or DKIM `{ error }` note, or no DMARC result at all | `450 4.7.0 Sender authentication temporarily unavailable, try again later` |

Each refusal is logged with `loginfo`. The enhanced status code starts the reply text, so Haraka's `deny_includes_uuid` must stay unset.

## Header recipients

`headerRecipients` lists the `To` and `Cc` mailboxes, `To` first, in header order, every instance of each header, with a group's members as mailboxes. Each is built with `address-rfc2821` exactly like `headerFrom`. An address that is not a valid RFC 5321 mailbox is left out, and the list is `[]` when there are none.

Unlike `rcptTo`, it does not depend on how the sender's server split the delivery: Gmail sends a reply-all with one recipient per transaction, but every transaction carries the full `To`/`Cc`.

`headerRecipients` is additive. Consumers that don't know it ignore it.

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
