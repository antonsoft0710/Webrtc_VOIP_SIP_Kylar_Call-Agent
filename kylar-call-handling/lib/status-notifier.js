const request = require('request');
//require('request-debug')(request);

function notifyStatus(logger, uri, status) {
  logger.info(`sending status: ${JSON.stringify(status)}`);
  return new Promise((resolve) => {
    logger.debug(`sending status to callback ${uri}`);
    request({
      uri,
      method: 'POST',
      json: true,
      time: true,
      body: status
    }, (err, response, body) => {
      if (err) {
        logger.info(`got error notifying status ${err}`);
      }
      else {
        logger.debug(`round-trip time for status notify ${response.elapsedTime} milliseconds`);
        if (response.statusCode !== 200) {
          logger.info(`HTTP error ${response.statusCode} notifying status: ${body}`);
        }
        else if (body) {
          logger.info(`response from status notify ${JSON.stringify(body)}`);
          if (body.actions && Array.isArray(body.actions)) return resolve(body.actions);
        }
      }
      resolve(null);
    });
  });
}

function notifyTranscript(logger, uri, transcript) {
  return new Promise((resolve) => {
    logger.debug(`sending transcript to callback ${uri}`);
    request({
      uri,
      method: 'POST',
      json: true,
      time: true,
      body: transcript
    }, (err, response, body) => {
      logger.info(`round-trip time for transcript notify ${response.elapsedTime} milliseconds`);
      if (err) logger.info(`got error notifying transcript ${err}`);
      else if (response.statusCode !== 200) {
        logger.info(`HTTP error ${response.statusCode} notifying transcript: ${body}`);
      }
      else if (body) {
        logger.info(`response from transcription notify ${JSON.stringify(body)}`);
        if (body.actions && Array.isArray(body.actions)) return resolve(body.actions);
      }
      resolve(null);
    });
  });
}

module.exports = {
  notifyStatus,
  notifyTranscript
};
