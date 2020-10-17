const config = require('config');
const {isWSS} = require('./utils');
const Client = require('rtpengine-client').Client ;
const rtpengine = new Client();
const offer = rtpengine.offer.bind(rtpengine, config.get('rtpengine'));
const answer = rtpengine.answer.bind(rtpengine, config.get('rtpengine'));
const del = rtpengine.delete.bind(rtpengine, config.get('rtpengine'));

module.exports = handler;

function handler({logger}) {
  return async(req, res) => {
    const {lb, registrar} = req.srf.locals;

    logger.info(req.uri, `received ${req.method} from ${req.protocol}/${req.source_address}:${req.source_port}`);

    const mediaservers = lb.getLeastLoaded();
    if (mediaservers.length === 0) {
      logger.info('no media servers currently available to handle this call');
      return res.send(480);
    }

    // each agent has a conference named with their username / realm
    const confName = `${req.authorization.username}-${req.authorization.realm}`;
    const aor = `${req.authorization.username}@${req.authorization.realm}`;
    const ms = mediaservers[0];
    let ep, dlg;
    const rtpEngineOpts = makeRtpEngineOpts(req, isWSS(req), false);
    const rtpEngineResource = {destroy: del.bind(rtpengine, rtpEngineOpts.common)};
    try {

      // allocate endpoint on rtpengine facing "inwards" (towards freeswitch)
      let response = await offer(rtpEngineOpts.offer);
      if ('ok' !== response.result) {
        throw new Error(`failed allocating rtpengine endpoint: ${JSON.stringify(response)}`);
      }

      // create an endpoint on Freeswitch receiving stream from that rtpengine endpoint
      ep = await ms.createEndpoint({remoteSdp: response.sdp});
      logger.info(`successfully created endpoint with SDP ${ep.local.sdp}`);
      ep.on('destroy', () => {
        logger.info('got BYE from Freeswitch for agent endpoint');
      });

      // allocate endpoint on rtpengine facing "outwards" (toward webRTC client)
      response = await answer(Object.assign({'sdp': ep.local.sdp, 'to-tag': ep.dialog.sip.remoteTag},
        rtpEngineOpts.answer));
      if ('ok' !== response.result) {
        throw new Error(`failed allocating second rtpengine endpoint: ${JSON.stringify(response)}`);
      }

      dlg = await req.srf.createUAS(req, res, {localSdp: response.sdp});

      // call is now connected to Freeswitch, with media flowing through rtpengine

      // release resources when caller hangs up
      dlg.on('destroy', onCallerHangup.bind(null, registrar, logger, confName, aor, [ep, rtpEngineResource]));
      dlg.on('info', onInfo.bind(null, logger, ms, ep, confName));

      // connect agent to her conference, automatically ending conference when she leaves
      await ep.play('silence_stream://1000'); // 1 sec of silence, to avoid clipping
      const {memberId, confUuid} = await ep.join(confName, {
        flags: {
          endconf: true,
          moderator: true
        }
      });
      ep.api('conference', `${confName} set max_members 2`)
        .catch((err) => logger.info(err, 'Error setting max members to 2'));
      logger.info(`successfully connected agent to conference ${confName} with memberId ${memberId}`);
      registrar.addConf(aor, ms.address);

    } catch (err) {
      logger.error(err, 'Error connecting caller into conference');
      [ep, rtpEngineResource].forEach((r) => r && r.destroy().catch((err) => logger.error(err)));
    }
  };
}

function onCallerHangup(registrar, logger, confName, aor, resources) {
  logger.info(`agent in conference ${confName} hung up`);
  resources.forEach((r) => r && r.destroy().catch((err) => logger.error(err)));
  registrar.removeConf(aor);
}

function onInfo(logger, ms, ep, confName, req, res) {
  if (req.get('Content-Type') === 'application/dtmf-relay') {
    const arr = /Signal=\s+#/.exec(req.body);
    if (arr) {
      logger.info('kicking participant');
      ep.api('conference ', `${confName} kick non_moderator`, (err, evt) => {
        if (err) return logger.error(err, 'Error kicking participant');
        logger.info('successfully kicked participant');
      });
    }
    else {
      logger.info(`discarding dtmf info: ${req.body}`);
    }
  }
  res.send(200);
}

function makeRtpEngineOpts(req, srcIsUsingSrtp, dstIsUsingSrtp) {
  const from = req.getParsedHeader('from');
  const common = {'call-id': req.get('Call-ID'), 'from-tag': from.params.tag};
  const rtpCharacteristics = config.get('transcoding.rtpCharacteristics');
  const srtpCharacteristics = config.get('transcoding.srtpCharacteristics');
  return {
    common,
    offer: Object.assign({'sdp': req.body, 'replace': ['origin', 'session-connection']}, common,
      dstIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics),
    answer: Object.assign({}, common, srcIsUsingSrtp ? srtpCharacteristics : rtpCharacteristics)
  };
}
