const config = require('config');
const bluebird = require('bluebird');
const redis = require('redis');
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
const redisOpts = Object.assign('test' === process.env.NODE_ENV ?
  {retry_strategy: () => {}, disable_resubscribing: true} : {});

function makeUserKey(aor) {
  return `user:${aor}`;
}

function makeConfKey(aor) {
  return `conf:${aor}`;
}

class Registrar {
  constructor(logger) {
    this.logger = logger;
    this.client = redis.createClient(config.get('redis.port'), config.get('redis.address'), redisOpts);
    this.client
      .on('connect', () => {
        logger.info(`successfully connected to redis at ${config.get('redis.address')}:${config.get('redis.port')}`);
      })
      .on('error', (err) => {
        logger.error(err, 'redis connection error') ;
      });
  }


  async query(aor) {
    const key = makeUserKey(aor);
    const result = await this.client.hgetallAsync(key);
    this.logger.info(`Registrar#query: ${aor} returned ${JSON.stringify(result)}`);
    return result;
  }

  async queryConf(aor) {
    const key = makeConfKey(aor);
    const addr = await this.client.getAsync(key);
    this.logger.info(`Registrar#queryConf: ${aor} returned ${addr}`);
    return addr;
  }

}

module.exports = Registrar;
