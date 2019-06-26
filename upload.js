const _ = require('lodash');
const fs = require('fs');
const log4js = require('log4js');
const path = require('path');
const request = require('request');
const urljoin = require('url-join');
const uuidv4 = require('uuid/v4');

const program = require('commander');

const TOKEN_URI = '/oauth/token';
const UPLOAD_URL_URI = '/api/v1/files/upload-url';
const TEST_PROJECT_URI = '/api/v1/test-projects';

const configs = {
  serverUrl: process.env.KATALON_SERVER_URL,
  email: process.env.KATALON_EMAIL,
  apikey: process.env.KATALON_API_KEY,
};

const oauth2 = {
  grant_type: 'password',
  client_secret: 'kit_uploader',
  client_id: 'kit_uploader',
};

const logConfigs = {
  appenders: {
    out: { type: 'stdout' },
  },
  categories: {
    default: { appenders: ['out'], level: 'INFO' },
  },
};
log4js.configure(logConfigs);
const logger = log4js.getLogger('katalon');


function buildOptions(url, headers, options) {
  const defaultOptions = {
    url,
    headers: headers || {},
    strictSSL: false,
  };
  options = _.merge(defaultOptions, options || {});
  return options;
}

const http = {
  request(baseUrl, relativeUrl, options, method) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    const url = urljoin(baseUrl, relativeUrl);
    options = buildOptions(url, headers, {
      ...options,
      json: true,
      method,
    });
    logger.trace('REQUEST:\n', options);
    const promise = new Promise((resolve, reject) => {
      request(options, (error, response, body) => {
        if (error) {
          logger.error(error);
          reject(error);
        } else {
          logger.info(`${method} ${response.request.href} ${response.statusCode}.`);
          resolve({ status: response.statusCode, body });
        }
      });
    }).then((response) => {
      response.requestUrl = options.url;
      logger.trace('RESPONSE:\n', response);
      return response;
    });
    return promise;
  },
  uploadToS3(signedUrl, filePath) {
    const stats = fs.statSync(filePath);
    const headers = {
      'content-type': 'application/octet-stream',
      accept: 'application/json',
      'Content-Length': stats.size,
    };
    const method = 'PUT';
    const options = buildOptions(signedUrl, headers, {
      method,
      json: true,
    });
    const promise = new Promise((resolve, reject) => {
      fs.createReadStream(filePath).pipe(request(options, (error, response, body) => {
        if (error) {
          logger.error(error);
          reject(error);
        } else {
          logger.info(`${method} ${response.request.href} ${response.statusCode}.`);
          resolve({ status: response.statusCode, body });
        }
      }));
    });
    return promise;
  },
};

const katalonRequest = {
  requestToken(email, password) {
    const data = {
      username: email,
      password,
      grant_type: oauth2.grant_type,
    };
    const options = {
      auth: {
        username: oauth2.client_id,
        password: oauth2.client_secret,
      },
      form: data,
      json: true,
    };
    return http.request(configs.serverUrl, TOKEN_URI, options, 'post');
  },

  getUploadInfo(token, projectId) {
    const options = {
      auth: {
        bearer: token,
      },
      json: true,
      qs: {
        projectId,
      },
    };
    return http.request(configs.serverUrl, UPLOAD_URL_URI, options, 'get');
  },
  uploadFile(uploadUrl, filePath) {
    return http.uploadToS3(uploadUrl, filePath);
  },
  uploadTestProject(token, projectId, batch, fileName, uploadedPath, opts = {}) {
    const url = `${TEST_PROJECT_URI}/${projectId}/update-package`;
    const options = {
      auth: {
        bearer: token,
      },
      json: true,
      qs: {
        projectId,
        batch,
        folderPath: '',
        fileName,
        uploadedPath,
        ...opts,
      },
    };
    return http.request(configs.serverUrl, url, options, 'post');
  },
};

function updateConfig(commandLineConfigs) {
  commandLineConfigs = _.pickBy(commandLineConfigs, value => value !== undefined);
  _.assign(configs, commandLineConfigs);
}

let token;

function uploadTestProject(projectId, filePath) {
  katalonRequest.requestToken(configs.email, configs.apikey)
    .then(({ body }) => {
      token = body.access_token;
      return katalonRequest.getUploadInfo(token, projectId);
    })
    .then(({ body }) => {
      const { uploadUrl } = body;
      const uploadedPath = body.path;
      return katalonRequest.uploadFile(uploadUrl, filePath)
        .then(() => {
          const batch = `${new Date().getTime()}-${uuidv4()}`;
          const fileName = path.basename(filePath);
          katalonRequest.uploadTestProject(token, projectId, batch, fileName, uploadedPath);
        });
    })
    .then(() => logger.info('Uploaded file:', filePath))
    .catch(err => logger.error(err));
}

program
  .command('upload <path>')
  .option('-s, --server-url <value>', 'Katalon Analytics URL')
  .option('-u, --username <value>', 'Email')
  .option('-p, --password <value>', 'Password')
  .option('-P, --project <value>', 'Katalon Project Id')
  .action((filePath, command) => {
    const options = {
      serverUrl: command.serverUrl,
      email: command.username,
      apikey: command.password,
      projectId: command.project,
    };
    updateConfig(options);
    uploadTestProject(options.projectId, filePath);
  });

program.parse(process.argv);
