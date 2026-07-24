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

When the Kafka message schema changes (for example, replacing `isBounce` with `inboundType`/`bounceStatus`), bump `messageVersion` in `config/duotail.ini` so downstream consumers can safely branch on the schema version.

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
