const Srf = require('drachtio-srf');
const srf = new Srf();
const {LoadBalancer} = require('drachtio-fn-fsmrf-sugar');
const CallSession = require('./lib/call-session');
const Status = require('./lib/status');
const config = require('config');
const logger = require('pino')(config.get('logging'));
const short = require('short-uuid');
const argv = require('minimist')(process.argv.slice(2));
const callsInProgress = new Map();
const assert = require('assert');

assert.ok(config.has('sipTrunk.host'), 'sipTrunks.host missing in config');

srf.connect(config.get('drachtio'));
srf.on('connect', async(err, hp) => {
  if (err) throw err;
  logger.info(`connected to drachtio listening on ${hp}`);
  const lb = srf.locals.lb = new LoadBalancer();
  await lb.start({servers: config.get('freeswitch'), logger, srf});
});
if (process.env.NODE_ENV !== 'test') {
  srf.on('error', (err) => logger.error(err));
}

// simple HTTP API
const port = argv.port || 3001;
const express = require('express');
const bodyParser = require('body-parser');
const {notifyStatus, notifyTranscript} = require('./lib/status-notifier');

const app = express();
app.use(bodyParser.json());

app.listen(port, () => logger.info(`listening on port ${port}`));

app.post('/api/outdial', async(req, res) => {
  const uuid = short.generate();
  const opts = {
    from: req.body.from,
    to: req.body.to,
    locale: req.body.locale || 'en-US',
    sipTrunk: req.body.sipTrunk,
    statusCallbackUrl: req.body.statusCallbackUrl,
    controlCallbackUrl: req.body.controlCallbackUrl,
    theirCallId: req.body.theirCallId,
    firstResponsePlayUrl: req.body.firstResponsePlayUrl
  };
  if (!opts.from || !opts.to || !opts.statusCallbackUrl || !opts.controlCallbackUrl) {
    return res.status(503).send('missing required query args');
  }
  res.status(202).json({
    status: 'success',
    callUUID: uuid
  });
  logger.info(opts, `received outdial request, assigned uuid ${uuid}`);

  // launch outdial
  const callSession = new CallSession(srf, logger, uuid, opts);
  try {
    callSession
      .on('callStatusChange', async(evt) => {
        logger.info(callSession.theirCallId + `call status change ${evt.oldStatus} => ${evt.newStatus}`);
        const status = {status: evt.newStatus};
        if (evt.newStatus === Status.STATUS_DISCONNECTED) {
          callSession.removeAllListeners();
          Object.assign(status, {
            callRecording: callSession.recording,
            callLength: callSession.callLength
          });
        }
        const actions = await notifyStatus(logger, req.body.statusCallbackUrl, status);
        if (actions) callSession.execute(actions);
      })
      .on('transcription', async(evt) => {
        logger.info(evt, `${callSession.theirCallId} received final transcription`);
        const actions = await notifyTranscript(logger, req.body.controlCallbackUrl, {
          playInProgress: evt.playInProgress,
          transcript: evt.alternatives[0].transcript,
          transcriptConfidence: evt.alternatives[0].confidence
        });
        if (actions) callSession.execute(actions);
      })
      .on('speech-not-recognized', async() => {
        const status = {status: 'speech-not-recognized'};
        const actions = await notifyStatus(logger, req.body.statusCallbackUrl, status);
        if (actions) callSession.execute(actions);
      })
      .on('no-speech-detected', async() => {
        const status = {status: 'no-speech-detected'};
        const actions = await notifyStatus(logger, req.body.statusCallbackUrl, status);
        if (actions) callSession.execute(actions);
      })
      .on('mergeFailure', async({reason}) => {
        logger.info(callSession.theirCallId +  ` merge failed: ${reason}`);
        const actions = await notifyStatus(logger, req.body.statusCallbackUrl, {status: 'merge failed', reason});
        if (actions) callSession.execute(actions);
      })
      .on('mergeSuccess', (evt) => logger.info(evt, `${callSession.theirCallId} merge succeeded`))
      .on('destroy', () => {
        callsInProgress.delete(callSession.uuid);
      });

    await callSession.outdial();
    callsInProgress.set(uuid, callSession);
    callSession.startRecording();
  } catch (err) {
    callSession.removeAllListeners();
  }
});

app.delete('/api/hangup/:id', (req, res) => {
  const uuid = req.params.id;
  const callSession = callsInProgress.get(uuid);
  if (!callSession) {
    logger.info(`received hangup request for uuid ${uuid}, which does not exist`);
    return res.status(404).end();
  }
  logger.info(`received hangup request for uuid ${uuid}`);
  callsInProgress.delete(uuid);
  callSession.disconnect();
});

module.exports = {srf};
