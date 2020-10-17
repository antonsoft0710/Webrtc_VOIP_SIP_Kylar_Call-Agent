const config = require('config');
const Client = require('rtpengine-client').Client ;
const rtpengine = new Client();
const offer = rtpengine.offer.bind(rtpengine, config.get('rtpengine'));
const answer = rtpengine.answer.bind(rtpengine, config.get('rtpengine'));
const del = rtpengine.delete.bind(rtpengine, config.get('rtpengine'));
const Emitter = require('events');
const Status = require('./status');
const moment = require('moment');
const SipError = require('drachtio-srf').SipError;
const Registrar = require('./registrar');
const EVENT_TRANSCRIPTION = 'google_transcribe::transcription';
const EVENT_END_OF_UTTERANCE = 'google_transcribe::end_of_utterance';
const EVENT_END_OF_TRANSCRIPT = 'google_transcribe::end_of_transcript';
const EVENT_NO_AUDIO = 'google_transcribe::no_audio_detected';

class CallSession extends Emitter {
  constructor(srf, logger, uuid, opts) {
    super();

    this.uuid = uuid;
    this.srf = srf;
    this.logger = logger.child({uuid: this.uuid});
    this.from = opts.from;
    this.to = opts.to;
    this.locale = opts.locale;
    this.statusCallbackUrl = opts.statusCallbackUrl;
    this.controlCallbackUrl = opts.controlCallbackUrl;
    this.theirCallId = opts.theirCallId;
    this.firstResponsePlayUrl = opts.firstResponsePlayUrl;
    this.status = Status.STATUS_STARTED;
    this.registrar = new Registrar(logger);
    this.dlg = null;
    this.ms = null;
    this.ep = null;
    this.times = {
      attempt: null,
      start: null,
      stop: null
    };
    this.playInProgress = false;
    this.gotInterimTranscription = false;
    this.gotFinalTranscription = false;
    this.sipTrunk = opts.sipTrunk;
  }

  get callLength() {
    return this.times.start && this.times.stop ?
      this.times.stop.diff(this.times.start, 'seconds') :
      0;
  }

  async outdial() {
    try {
      this.times.attempt = moment();
      this._setStatus(Status.STATUS_INITIATED);
      this.ms = this._getMS();
      this.ep = await this._getEndpoint(this.ms);
      const offerSdp = await this._getOffer(this.ep);
      this.dlg = await this._createCall(offerSdp);
      this._setCallEventHandlers();
      this._setStatus(Status.STATUS_CONNECTED);
    } catch (err) {
      this._handleErrorDuringOutdial(err);
      throw new Error('call failure');
    }
    return this;
  }

  async startRecording() {
    this.ep.set('RECORD_STEREO', true);
    this.recording = `/tmp/${this.dlg.sip.callId}.wav`;
    this.ep.recordSession(this.recording);
    this.ep.startTranscription({locale: this.locale, interim: true});
    this.ep.addCustomEventListener(EVENT_TRANSCRIPTION, this._onTranscription.bind(this));
    this.ep.addCustomEventListener(EVENT_END_OF_UTTERANCE, this._onEndOfUtterance.bind(this));
    this.ep.addCustomEventListener(EVENT_END_OF_TRANSCRIPT, this._onEndOfTranscript.bind(this));
    this.ep.addCustomEventListener(EVENT_NO_AUDIO, this._onNoAudio.bind(this));

    this.logger.info(`started recording and transcription with locale: ${this.locale}`);
  }

  async execute(actions) {
    this.logger.info(`executing actions: ${JSON.stringify(actions)}`);
    for (const a of actions) {
      if (this.status === Status.STATUS_DISCONNECTED) return;
      this.logger.info(`performing action ${JSON.stringify(a)}`);
      const fn = this[`_${a.action}`] ;
      if (!fn) this.logger.info(`invalid action ${a.action}`);
      else await fn.bind(this)(a);
    }
    this.logger.info('completed all requested actions');
  }

  disconnect() { this._disconnect(); }

  _getMS() {
    const mediaservers = this.srf.locals.lb.getLeastLoaded();
    if (mediaservers.length === 0) {
      throw new Error('no media servers currently available to handle this call');
    }
    return mediaservers[0];
  }

  async _getEndpoint(ms) {
    const ep = await ms.createEndpoint({codecs: 'PCMU'});
    this.logger.debug(`allocated ms endpoint: ${ep.local.sdp}`);
    if (config.has('speechSettings')) {
      ep.set(config.get('speechSettings'));
    }
    await ep.set({
      'GOOGLE_SPEECH_MODEL': 'command_and_search',
      'GOOGLE_SPEECH_SINGLE_UTTERANCE': true
    });

    await ep.execute('start_dtmf_generate');

    if (config.has('conference-comfort-noise') && config.get('conference-comfort-noise') === true) {
      this.logger.info('connecting to comfort noise conference');
      ep.execute('conference', 'silence@silence++flags{mute}');
    }
    return ep;
  }

  async _getOffer(ep) {
    const callId = ep.dialog.sip.callId;
    const fromTag = ep.dialog.sip.localTag;
    const sdp = ep.local.sdp;
    this.logger.debug(`ep sdp: ${sdp}`);
    this.rtpOpts = this._makeRtpEngineOpts(callId, fromTag, sdp);
    const response = await offer(this.rtpOpts.offer);
    if ('ok' !== response.result) throw new Error(`RTPE fail 1: ${JSON.stringify(response)}`);
    this.logger.debug(`sdp #1 allocated by rtpengine: ${response.sdp}`);
    return response.sdp;
  }

  async _createCall(sdp) {
    const uri = `sip:${this.to}@${this.sipTrunk.host}`;
    this.dlg = await this.srf.createUAC(uri, {
      localSdp: sdp,
      auth: this.sipTrunk.auth,
      headers: {
        From: `sip:${this.from}@${config.get('sipTrunk.host')}`,
        to: uri
      }
    }, {
      cbProvisional: (provisionalRes) => {
        if (this.status !== Status.STATUS_RINGING && [180, 183].includes(provisionalRes.status)) {
          this._setStatus(Status.STATUS_RINGING);
        }
      }
    });
    const response = await answer(Object.assign({
      'sdp': this.dlg.remote.sdp,
      'to-tag': this.ep.dialog.sip.remoteTag
    }, this.rtpOpts.answer));
    if ('ok' !== response.result) throw new Error(`RTPE fail2: ${JSON.stringify(response)}`);
    this.logger.debug(`sdp #2 allocated by rtpengine: ${response.sdp}`);
    await this.ep.modify(response.sdp);
    this.logger.info('call successfully connected');
    this.sipCallId = this.dlg.sip.callId;
    this.times.start = moment();
    return this.dlg;
  }

  _handleErrorDuringOutdial(err) {
    this.times.stop = moment();
    if (err instanceof SipError) {
      this.logger.info({callId: this.sipCallId}, `outdial failed with status ${err.status}`);
      switch (err.status) {
        case 480:
        case 487:
          this._setStatus(Status.STATUS_NOANSWER);
          break;
        case 486:
        case 603:
          this._setStatus(Status.STATUS_BUSY);
          break;
        default:
          this._setStatus(Status.STATUS_FAILED);
          break;
      }
    }
    else {
      this.logger.error(err, 'Outdial failure');
      this._setStatus(Status.STATUS_FAILED);
    }
    if (this.ep) this.ep.destroy();
    if (this.rtpOpts) del(this.rtpOpts.common);
  }

  _onTranscription(evt) {
    Object.assign(evt, {playInProgress: this.playInProgress});
    this.logger.info(evt, 'received transcription:');
    if (evt.is_final === true) {
      this.gotFinalTranscription = true;
      this.emit('transcription', Object.assign({playInProgress: this.playInProgress}, evt));
    }
    else {
      this.gotInterimTranscription = true;
    }
  }

  _onEndOfUtterance() {
    this.logger.info('received end of utterance');
    if (this.firstResponsePlayUrl) {
      const url = this.firstResponsePlayUrl;
      this.firstResponsePlayUrl = null;
      this.logger.info(`playing the first prompt we were given ${url}`);
      this._play({url});
      this.firstResponsePlayUrl = null;
    }
  }

  _onEndOfTranscript() {
    this.logger.info('received end of transcript, starting new recognize request');
    if (!this.gotFinalTranscription) {
      if (this.gotInterimTranscription) this.emit('speech-not-recognized');
      else this.emit('no-speech-detected');
    }
    this.gotFinalTranscription = this.gotInterimTranscription = false;
    this.ep.startTranscription({locale: this.locale, interim: true});
  }

  _onNoAudio() {
    this.logger.info('received no audio error, starting new recognize request');
    this.emit('no-speech-detected');
    this.gotFinalTranscription = this.gotInterimTranscription = false;
    this.ep.startTranscription({locale: this.locale, interim: true});
  }

  _setStatus(status) {
    this.emit('callStatusChange', {oldStatus: this.status, newStatus: status});
    this.status = status;
  }

  _setCallEventHandlers() {
    this.dlg.on('destroy', () => {
      this.logger.info('call ended with called party hang up');
      this.times.stop = moment();
      this._setStatus(Status.STATUS_DISCONNECTED);
      if (this.ep) this.ep.destroy();
      if (this.rtpOpts) del(this.rtpOpts.common);
      this._clearMergeResources();
      this.emit('destroy');
    });
  }

  _disconnect() {
    this.logger.info('call ended with disconnect from API');
    this.times.stop = moment();
    this._setStatus(Status.STATUS_DISCONNECTED);
    this.dlg.destroy();
    this.ep.destroy();
    del(this.rtpOpts.common);
    this._clearMergeResources();
  }

  async _play(opts) {
    try {
      this.playInProgress = true;
      await this.ep.play(opts.url);
    } catch (err) {
      this.logger.error(err, `Error playing file: ${opts.url}`);
    }
    this.playInProgress = false;
  }

  async _sendTones(opts) {
    try {
      await this.ep.execute('send_dtmf', `${opts.tones}@${opts.duration || 100}`);
      await this.ep.play('silence_stream://1000'); // 1 sec of silence
    } catch (err) {
      this.logger.error(err, `Error sending tones: ${JSON.stringify(opts)}`);
    }
  }

  async _merge(opts) {
    try {
      if (this.status === Status.STATUS_MERGED) {
        return this.emit('mergeFailure', {userId: opts.userId, reason: `user ${opts.userId} is already merged`});
      }
      const addr = await this.registrar.queryConf(opts.userId);
      this.logger.info(`conference for ${opts.userId} is on ${addr}, call is on ${this.ms.address}`);
      if (!addr) {
        return this.emit('mergeFailure', {userId: opts.userId, reason: `user ${opts.userId} is not online`});
      }

      // take the call out of the comfort noise conference
      const obj = await this.ep.getChannelVariables();
      this.memberIdComfort = obj['variable_conference_member_id'];
      this.logger.info(`connected to comfort noise conference with memberId: ${this.memberIdComfort}`);
      //this.logger.debug(JSON.stringify(obj));

      if (this.memberIdComfort) {
        try {
          this.logger.info(`taking member ${this.memberIdComfort} out of comfort noise conference`);
          await this.ep.api(`conference silence hup ${this.memberIdComfort}`);
          this.memberIdComfort = null;
        } catch (err) {
          this.logger.info(err, 'Error removing call from comfort noise conference');
        }
      }

      const confName = opts.userId.replace('@', '-');
      if (this.ms.address === addr) {
        // simple case: the call and the agent conference are on the same media server
        this.logger.info(`joining caller to conference ${confName} on the same media server`);
        await this.ep.join(confName);
        this._setKickHandler();
        this.emit('mergeSuccess', {userId: opts.userId, conf: confName, ms: this.ms.address});
      }
      else {
        // more complicated: conference is on one media server, the call on another
        this.logger.info(`joining caller to conference ${confName} on a different media server`);

        // get a reference to the media server the conference is on (may be different than the current call)
        this.msConf = this.srf.locals.lb.getMsByEslAddress(addr);

        // allocate a new endpoint on the current media server, and bridge it to the call
        this.epBridge = await this.ms.createEndpoint({codecs: 'PCMU'});
        await this.ep.bridge(this.epBridge);

        // allocate a new endpoint on the conference ms and join it to the conference
        this.epConf = await this.ms.createEndpoint({codecs: 'PCMU'});
        await this.epConf.join(confName);

        // INVITE each endpoint to stream to each other
        this.epBridge.modify(this.epConf.local.sdp);
        this.epConf.modify(this.epBridge.local.sdp);

        this._setKickHandler();
      }
      this._setStatus(Status.STATUS_MERGED);
    } catch (err) {
      this.logger.error(err, `Error doing merge to: ${JSON.stringify(opts)}`);
      this._clearMergeResources();
    }
  }

  _setKickHandler() {
    const ep = this.epConf || this.ep;
    ep.conn.on('esl::event::CUSTOM::*', (evt) => {
      const eventName = evt.getHeader('Event-Subclass') ;
      if (eventName === 'conference::maintenance') {
        const action = evt.getHeader('Action') ;
        if (action === 'kick-member') {
          this.logger.info('kicked from conference by moderator');
          this._doKick();
        }
      }
    });
  }

  _doKick() {
    this.logger.info('call ended with called party kicked from conference');
    this.dlg.destroy();
    this.ep.destroy();
    this.times.stop = moment();
    this._setStatus(Status.STATUS_DISCONNECTED);
    if (this.rtpOpts) del(this.rtpOpts.common);
    this._clearMergeResources();
  }

  _clearMergeResources() {
    if (!this.msConf) return;
    if (this.epConf) this.epConf.destroy();
    if (this.epBridge) this.epBridge.destroy();
  }

  _makeRtpEngineOpts(callId, fromTag, sdp) {
    const common = {'call-id': callId, 'from-tag': fromTag};
    const rtpCharacteristics = config.get('transcoding.rtpCharacteristics');
    return {
      common,
      offer: Object.assign({'sdp': sdp, 'replace': ['origin', 'session-connection']},
        common, rtpCharacteristics),
      answer: Object.assign({}, common, rtpCharacteristics)
    };
  }

}

module.exports = CallSession;
