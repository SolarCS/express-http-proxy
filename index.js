var assert = require('assert');
var util = require('util');
var url = require('url');
var http = require('http');
var https = require('https');
var is = require('type-is');
var getRawBody = require('raw-body');

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

  var cache = {}
  var buildCacheKey = function(method, path, body) {
    return [method, path, body].join('+');
  }
  var cacheResponse = function(cacheKey, resBody) {
    cache[cacheKey] = resBody;
  }

  return function handleProxy(req, res, next) {
    if (filter && !filter(req, res)) next();

    var headers = options.headers || {};
    var path;

    path = forwardPath ? forwardPath(req, res) : url.parse(req.url).path;

    var hds = extend(headers, req.headers, ['connection', 'host', 'content-length']);
    hds.connection = 'close';

    // var hasRequestBody = 'content-type' in req.headers || 'transfer-encoding' in req.headers;
    getRawBody(req, {
      length: req.headers['content-length'],
      limit: limit
    }, function(err, bodyContent) {
      if (err) return next(err);

      if (options.cachingEnabled) {
        var cacheKey = buildCacheKey(req.method, req.originalUrl, bodyContent);
        if (cache[cacheKey]) {
          return res.send(cache[cacheKey]);
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

              if (options.cachingEnabled) cacheResponse(cacheKey, rsp);

              if (!sent)
                res.send(rsp);
            });
          } else {
            if (options.cachingEnabled) cacheResponse(cacheKey, rspData);
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
