[![CI](https://github.com/taodong/haraka-plugin-duotail/actions/workflows/ci.yml/badge.svg)](https://github.com/taodong/haraka-plugin-duotail/actions/workflows/ci.yml)


# haraka-plugin-duotail

Haraka plugin for Duotail project. It routes the incoming email to a Hazelcast cache and sends a summary to a Kafka topic

## Dependency

For production environment, the following plugins are needed before this plugin:

- [mailauth](https://github.com/haraka/haraka-plugin-mailauth) — provides the SPF/DKIM results this plugin reads.
- [bounce](https://github.com/haraka/haraka-plugin-bounce) (`haraka-plugin-bounce`) — flags bounce/DSN messages this plugin reads. Keep its `[reject]` config options disabled so bounce mail still reaches this plugin instead of being rejected at SMTP time.

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
