var assert = require('assert');
var util = require('util');
var url = require('url');
var http = require('http');
var https = require('https');
var is = require('type-is');
var getRawBody = require('raw-body');
var fs = require('fs');
var mkdirp = require('mkdirp');

require('buffer');

module.exports = function proxy(host, options) {

  assert(host, 'Host should not be empty');

  options = options || {};

  var port = 80;

  var ishttps = /^https/.test(host);

  if (typeof host == 'string') {
    var mc = host.match(/^(https?:\/\/)/);
    if (mc) {
      host = host.substring(mc[1].length);
    }
    
    var h = host.split(':');
    host = h[0];
    port = h[1] || (ishttps ? 443 : 80);
  }


  /** 
   * intercept(data, res, req, function(err, json));
   */
  var intercept = options.intercept;
  var decorateRequest = options.decorateRequest;
  var forwardPath = options.forwardPath;
  var filter = options.filter;
  var limit = options.limit || '1mb';
  var cachingEnabled = options.cachingEnabled;
  var cacheDir = options.cacheDir || ("./tmp/cache");

  if (cachingEnabled) {
    mkdirp.sync(cacheDir);
  }

  var buildCacheKey = function(method, path, body) {
    return [method, path, body].join('____');
  }

  var buildCachePath = function(cacheKey) {
    return cacheDir + "/" + hashCode(cacheKey);
  }

  var buildCacheContentTypePath = function(cacheKey) {
    return cacheDir + "/" + hashCode(cacheKey) + "_content-type";
  }

  var cacheExists = function(cacheKey) {
    return fs.existsSync(buildCachePath(cacheKey));
  }

  var getCachedResponse = function(cacheKey) {
    return fs.readFileSync(buildCachePath(cacheKey));
  }

  var getCachedResponseContentType = function(cacheKey) {
    return fs.readFileSync(buildCacheContentTypePath(cacheKey));
  }

  var cacheResponse = function(cacheKey, res, resBody) {
    if (!cacheExists(cacheKey) && resBody) {
      if (contentType = res._headers['content-type']) {
        fs.writeFileSync(buildCacheContentTypePath(cacheKey), contentType);
      }
      fs.writeFileSync(buildCachePath(cacheKey), resBody);
    }
  }

  return function handleProxy(req, res, next) {
    if (filter && !filter(req, res)) next();

    var headers = options.headers || {};
    var path;

    path = forwardPath ? forwardPath(req, res) : url.parse(req.url).path;

    var hds = extend(headers, req.headers, ['connection', 'host', 'content-length','accept-encoding']);
    hds.connection = 'close';

    // var hasRequestBody = 'content-type' in req.headers || 'transfer-encoding' in req.headers;
    getRawBody(req, {
      length: req.headers['content-length'],
      limit: limit
    }, function(err, bodyContent) {
      if (err) return next(err);

      if (cachingEnabled) {
        var cacheKey = buildCacheKey(req.method, req.originalUrl, bodyContent);
        if (cacheExists(cacheKey)) {
          respBody = getCachedResponse(cacheKey);
          respContentType = getCachedResponseContentType(cacheKey);
          res.set('content-type', respContentType);
          res.set('content-length', respBody.length);
          return res.send(respBody);
        }
      }

      var reqOpt = {
        hostname: (typeof host == 'function') ? host(req) : host.toString(),
        port: port,
        headers: hds,
        method: req.method,
        path: path,
        bodyContent: bodyContent
      };

      if (decorateRequest)
        reqOpt = decorateRequest(reqOpt) || reqOpt;

      bodyContent = req.bodyContent = reqOpt.bodyContent;
      delete reqOpt.bodyContent;

      if (typeof bodyContent == 'string')
        reqOpt.headers['content-length'] = Buffer.byteLength(bodyContent);
      else if (Buffer.isBuffer(bodyContent)) // Buffer
        reqOpt.headers['content-length'] = bodyContent.length;

      var chunks = [];
      var realRequest = (ishttps ? https : http).request(reqOpt, function(rsp) {
        var rspData = null;
        rsp.on('data', function(chunk) {
          chunks.push(chunk);
        });

        rsp.on('end', function() {
          var totalLength = chunks.reduce(function(len, buf) {
            return len + buf.length;
          }, 0);

          var rspData = Buffer.concat(chunks, totalLength);

          if (intercept) {
            intercept(rspData, req, res, function(err, rsp, sent) {
              if (err) {
                return next(err);
              }
              
              if (typeof rsp == 'string') 
                rsp = new Buffer(rsp, 'utf8');
              
              if (!Buffer.isBuffer(rsp)) {
                next(new Error("intercept should return string or buffer as data"));
              }
              
              if (!res.headersSent)
                res.set('content-length', rsp.length);
              else if (rsp.length != rspData.length) {
                next(new Error("'Content-Length' is already sent, the length of response data can not be changed"));
              }
              if (cachingEnabled) cacheResponse(cacheKey, res, rsp);

              if (!sent)
                res.send(rsp);
            });
          } else {
            if (cachingEnabled) cacheResponse(cacheKey, res, rspData);
            res.send(rspData);
          }
        });

        rsp.on('error', function(e) {
          next(e);
        });


        if (!res.headersSent) { // if header is not set yet
          res.status(rsp.statusCode);
          for (var p in rsp.headers) {
            res.set(p, rsp.headers[p]);
          }
        }

      });

      realRequest.on('error', function(e) {
        next(e);
      });

      if (bodyContent.length) {
        realRequest.write(bodyContent);
      }

      realRequest.end();
    });
  };
};


function extend(obj, source, skips) {
  if (!source) return obj;

  for (var prop in source) {
    if (!skips || skips.indexOf(prop) == -1)
      obj[prop] = source[prop];
  }

  return obj;
}

hashCode = function(str) {
  var hash = 0;
  for (i = 0; i < str.length; i++) {
      char = str.charCodeAt(i);
      hash = char + (hash << 6) + (hash << 16) - hash;
  }
  return hash;
}
