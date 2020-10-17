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

  async add(aor, contact, protocol, expires) {
    this.logger.info(`Registrar#add ${aor} from ${protocol}/${contact} for ${expires}`);
    const key = makeUserKey(aor);
    try {
      const result = await this.client
        .multi()
        .hmset(key, {contact, protocol})
        .expire(key, expires)
        .execAsync();
      this.logger.info(`Registrar#add - result of adding ${aor}: ${result}`);
    } catch (err) {
      this.logger.error(err, `Error adding user ${aor}`);
    }
  }

  async query(aor) {
    const key = makeUserKey(aor);
    const result = await this.client.hgetallAsync(key);
    this.logger.info(`Registrar#query: ${aor} returned ${JSON.stringify(result)}`);
    return result;
  }

  remove(aor) {
    const key = makeUserKey(aor);
    this.logger.info(`Registrar#remove ${aor}`);
    return this.client.delAsync(key);
  }

  async addConf(aor, addr) {
    this.logger.info(`Registrar#addConf ${aor} is on ${addr}`);
    const key = makeConfKey(aor);
    try {
      const result = await this.client.setAsync(key, addr);
      this.logger.info(`Registrar#addConf - result of adding ${aor}: ${result}`);
    } catch (err) {
      this.logger.error(err, `Error adding conf for ${aor}`);
    }
  }

  async queryConf(aor) {
    const key = makeConfKey(aor);
    const addr = await this.client.getAsync(key);
    this.logger.info(`Registrar#queryConf: ${aor} returned ${addr}`);
    return addr;
  }

  async removeConf(aor) {
    this.logger.info(`Registrar#removeConf ${aor}`);
    const key = makeConfKey(aor);
    return this.client.delAsync(key);
  }

}

module.exports = Registrar;
