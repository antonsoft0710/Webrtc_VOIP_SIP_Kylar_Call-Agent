const Srf = require('drachtio-srf');
const srf = new Srf();
const config = require('config');
const logger = require('pino')(config.get('logging'));
const regParser = require('drachtio-mw-registration-parser') ;
const {digestChallenge, spamCheck, validateDialedNumber} = require('./lib/middleware');
const Registrar = require('./lib/registrar');
srf.locals.registrar = new Registrar(logger);
const {LoadBalancer} = require('drachtio-fn-fsmrf-sugar');
const lb = srf.locals.lb = new LoadBalancer();

srf.connect(config.get('drachtio'));
srf.on('connect', (err, hp) => {
  if (err) throw err;
  logger.info(`connected to drachtio listening on ${hp}`);
  lb.start({servers: config.get('freeswitch'), srf, logger});
})
  .on('error', (err) => logger.error(err));


// middleware
srf.use(spamCheck(logger));
srf.use('register', [digestChallenge(logger), regParser]);
srf.use('invite', [digestChallenge(logger), validateDialedNumber(logger)]);

srf.invite(require('./lib/invite')({logger}));
srf.register(require('./lib/register')({logger}));

module.exports = {srf};
