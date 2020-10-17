# kylar-call-handling

This application illustrates how to place an outbound call and both record the session as well as obtain real-time transcriptions of speech.  Given a destination number, this application outdials that number through a SIP trunking provider, and upon answer begins recording the session (to the /tmp directory) and also logs to the console transcripts of the caller audio in real-time, using Google speech.  After the first transcription is detected, a wave file is played to the caller.

## Installation
In the config directory,copy `local.json.example` to `local.json` and modify as appropriate.  Then install and run as per usual:

```
$ npm init
$ npm start --from="19166190980" --to="15083084809" --locale en-US | pino-pretty -c -t
```

The 'from' phone number should be a valid DID provided by your SIP trunking provider, the 'to' phone number is the phone number that you want to call (in E.164 format, without the leading plus sign).
> Note: piping the output to "pino-pretty" is not required but makes the JSON logging output easier to read.

> Note: the `--locale` argument is optional, and will default to en-US if not provided.  This must be a supported Google speech locale and defines the language dialect that is used by the recognizer.

As illustrated above, this initial version of the application requires command line arguments and is a "one shot" type of application (ends after caller hangs up).  Future versions will expose an HTTP API that can be used to trigger outdials.

### Configuration
```
  "drachtio": {
    "host": "127.0.0.1",
    "port": 9022,
    "secret": "cymru"
  }
```
Information describing the location of the drachtio server to connect to.

```
  "freeswitch": [{
    "address": "127.0.0.1",
    "port": 8021,
    "secret": "ClueCon"
  }]
```
An array of Freeswitch servers to connect to. The Freeswitch servers must be built with support for [mod_google_transcribe](https://github.com/davehorton/drachtio-freeswitch-modules/blob/master/modules/mod_google_transcribe/README.md), see [this ansible role](https://github.com/davehorton/ansible-role-fsmrf) for use in building Freeswitch and associated modules from source on a Debian 9 (stretch) server.

```
  "logging": {
    "level": "info"
  }
```

```
  "sipTrunk": {
    "host": "kylar.pstn.twilio.com",
    "auth": {
      "username": "your-sip-username",
      "password": "your-sip-password"
    }
  }
```
SIP trunk to use when performing the outdial.  If the sip trunking provider requires authentication, supply the username and password where indicated.
