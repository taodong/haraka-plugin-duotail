[![CI Test Status][ci-img]][ci-url]

<!-- [![NPM][npm-img]][npm-url] -->

# haraka-plugin-duotail

Haraka plugin for Duotail project. It routes the incoming email to a Hazelcast cache and sends a summary to a Kafka topic

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
