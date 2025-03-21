'use strict';

var bitcore = require('qtepcore-lib');
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var Common = require('./common');
var async = require('async');

var MAXINT = 0xffffffff; // Math.pow(2, 32) - 1;

function TxController(opts) {
  this.node = opts.node;
  this.transactionService = opts.transactionService;
  this.common = new Common({log: this.node.log});
}

TxController.prototype.show = function(req, res) {
  if (req.transaction) {
    res.jsonp(req.transaction);
  }
};

/**
 * Find transaction by hash ...
 */
TxController.prototype.transaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.transactionService.getDetailedTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    self.transformTransaction(transaction, function(err, transformedTransaction) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      req.transaction = transformedTransaction;
      next();
    });

  });
};

TxController.prototype.transformTransaction = function(transaction, options, callback) {
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }
  $.checkArgument(_.isFunction(callback));

  var confirmations = 0;
  if(transaction.height >= 0) {
    confirmations = this.node.services.qtepd.height - transaction.height + 1;
  }

  var transformed = {
    txid: transaction.hash,
    version: transaction.version,
    locktime: transaction.locktime,
    receipt: transaction.receipt,
    isqrc20Transfer: transaction.isqrc20Transfer,
  };

  if(transaction.coinbase) {
    transformed.vin = [
      {
        coinbase: transaction.inputs[0].script,
        sequence: transaction.inputs[0].sequence,
        n: 0
      }
    ];
  } else {
    transformed.vin = transaction.inputs.map(this.transformInput.bind(this, options));
  }

  transformed.vout = transaction.outputs.map(this.transformOutput.bind(this, options));

  transformed.blockhash = transaction.blockHash;
  transformed.blockheight = transaction.height;
  transformed.confirmations = confirmations;

  var time;
  
  if (transaction.blockTimestamp) {
    time = transaction.blockTimestamp;
  } else if (transaction.receivedTime) {
    time = transaction.receivedTime;
  } else {
    time = Math.round(Date.now() / 1000);
  }

  transformed.time = time;

  if (transformed.confirmations) {
    transformed.blocktime = transformed.time;
  }

  if(transaction.coinbase) {
    transformed.isCoinBase = true;
  }

  transformed.valueOut = transaction.outputSatoshis / 1e8;
  transformed.size = transaction.hex.length / 2; // in bytes
  if (!transaction.coinbase) {
    transformed.valueIn = transaction.inputSatoshis / 1e8;
    transformed.fees = transaction.feeSatoshis / 1e8;
  }

  callback(null, transformed);
};

TxController.prototype.transformInput = function(options, input, index) {
  // Input scripts are validated and can be assumed to be valid
  var transformed = {
    txid: input.prevTxId,
    vout: input.outputIndex,
    sequence: input.sequence,
    n: index
  };

  if (!options.noScriptSig) {
    transformed.scriptSig = {
      hex: input.script
    };
    if (!options.noAsm) {
      transformed.scriptSig.asm = input.scriptAsm;
    }
  }

  transformed.addr = input.address;
  transformed.valueSat = input.satoshis;
  transformed.value = input.satoshis / 1e8;
  transformed.doubleSpentTxID = null; // TODO
  //transformed.isConfirmed = null; // TODO
  //transformed.confirmations = null; // TODO
  //transformed.unconfirmedInput = null; // TODO

  return transformed;
};

TxController.prototype.transformOutput = function(options, output, index) {

  var transformed = {
    value: (output.satoshis / 1e8).toFixed(8),
    n: index,
    scriptPubKey: {
      hex: output.script
    }
  };

  if (!options.noAsm) {
    transformed.scriptPubKey.asm = output.scriptAsm;
  }

  if (!options.noSpent) {
    transformed.spentTxId = output.spentTxId || null;
    transformed.spentIndex = _.isUndefined(output.spentIndex) ? null : output.spentIndex;
    transformed.spentHeight = output.spentHeight || null;
  }

  if (output.address) {
    transformed.scriptPubKey.addresses = [output.address];
    var address = bitcore.Address(output.address); //TODO return type from bitcore-node
    transformed.scriptPubKey.type = address.type;
  }
  return transformed;
};

TxController.prototype.transformInvTransaction = function(transaction) {
  var self = this;

  var valueOut = 0;
  var vout = [];
  for (var i = 0; i < transaction.outputs.length; i++) {
    var output = transaction.outputs[i];
    valueOut += output.satoshis;
    if (output.script) {
      var address = output.script.toAddress(self.node.network);
      if (address) {
        var obj = {};
        obj[address.toString()] = output.satoshis;
        vout.push(obj);
      }
    }
  }

  var isRBF = _.any(_.pluck(transaction.inputs, 'sequenceNumber'), function(seq) {
    return seq < MAXINT - 1;
  });

  var transformed = {
    txid: transaction.hash,
    valueOut: valueOut / 1e8,
    vout: vout,
    isRBF: isRBF,
  };

  return transformed;
};

TxController.prototype.transformQtepTransaction = function(transaction) {

    var self = this;

    var valueOut = 0;
    var vout = [];
    var vin = [];
    for (var i = 0; i < transaction.outputs.length; i++) {
        var output = transaction.outputs[i];
        valueOut += output.satoshis;
        if (output.script) {
            var address = output.script.toAddress(self.node.network);
            if (address) {

                vout.push({
                    value: output.satoshis,
                    address: address.toString()
                });

            }
        }
    }

    for (var i = 0; i < transaction.inputs.length; i++) {
        var input = transaction.inputs[i];
        if (input.script) {
            var address = input.script.toAddress(self.node.network);
            if (address) {
                vin.push({
                    address: address.toString()
                })
            }

        }
    }

    var isRBF = _.any(_.pluck(transaction.inputs, 'sequenceNumber'), function(seq) {
        return seq < MAXINT - 1;
    });

    var transformed = {
        txid: transaction.hash,
        valueOut: valueOut / 1e8,
        vin: vin,
        vout: vout,
        isRBF: isRBF,
    };

    return transformed;
};

TxController.prototype.rawTransaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    req.rawTransaction = {
      'rawtx': transaction.toBuffer().toString('hex')
    };

    next();
  });
};

TxController.prototype.showRaw = function(req, res) {
  if (req.rawTransaction) {
    res.jsonp(req.rawTransaction);
  }
};

TxController.prototype.list = function(req, res) {
  var self = this;

  var blockHash = req.query.block;
  var address = req.query.address;
  var page = parseInt(req.query.pageNum) || 0;
  var pageLength = 10;
  var pagesTotal = 1;

  if(blockHash) {
    self.node.getBlockOverview(blockHash, function(err, block) {
      if(err && err.code === -5) {
        return self.common.handleErrors(null, res);
      } else if(err) {
        return self.common.handleErrors(err, res);
      }

      var totalTxs = block.txids.length;
      var txids;

      if(!_.isUndefined(page)) {
        var start = page * pageLength;
        txids = block.txids.slice(start, start + pageLength);
        pagesTotal = Math.ceil(totalTxs / pageLength);
      } else {
        txids = block.txids;
      }

      async.mapSeries(txids, function(txid, next) {
        self.transactionService.getDetailedTransaction(txid, function(err, transaction) {
          if (err) {
            return next(err);
          }
          self.transformTransaction(transaction, next);
        });
      }, function(err, transformed) {
        if(err) {
          return self.common.handleErrors(err, res);
        }

        res.jsonp({
          pagesTotal: pagesTotal,
          txs: transformed
        });
      });

    });
  } else if(address) {
    var options = {
      from: page * pageLength,
      to: (page + 1) * pageLength
    };

    self.node.getAddressHistory(address, options, function(err, result) {
      if(err) {
        return self.common.handleErrors(err, res);
      }

      var txs = result.items.map(function(info) {
        return info.tx;
      }).filter(function(value, index, self) {
        return self.indexOf(value) === index;
      });

      return async.eachSeries(txs, function (tx, callback) {
          return self.transactionService.addReceiptIfTransfersExists(tx, function (err, tx) {
              return callback(err);
          });
      }, function (err) {

        if (err) {
            return self.common.handleErrors(new Error('Receipt update error'), res);
        }

        async.map(
            txs,
            function(tx, next) {
                self.transformTransaction(tx, next);
            },
            function(err, transformed) {
                if (err) {
                    return self.common.handleErrors(err, res);
                }
                res.jsonp({
                    pagesTotal: Math.ceil(result.totalCount / pageLength),
                    txs: transformed
                });
            }
        );

      });



    });
  } else {
    return self.common.handleErrors(new Error('Block hash or address expected'), res);
  }
};

TxController.prototype.send = function(req, res) {
  var self = this,
      callback = function(err, txid) {
          if(err) {
              // TODO handle specific errors
              return self.common.handleErrors(err, res);
          }

          res.json({'txid': txid});
      };

  // API no longer supports `allowAbsurdFees`
  this.node.sendTransaction(req.body.rawtx, callback);

  // if (req.body.allowAbsurdFees === true || req.body.allowAbsurdFees === 'true') {
  //     this.node.sendTransaction(req.body.rawtx, {
  //         allowAbsurdFees: true
  //     }, callback);
  // } else {
  //     this.node.sendTransaction(req.body.rawtx, callback);
  // }

};

TxController.prototype.getTransactionReceipt = function(req, res) {

    var self = this;
    var txid = req.params.txid;

    return self.node.getTransactionReceipt(txid, function (err, result) {

        if(err) {
            return self.common.handleErrors(err, res);
        }

        return res.json(result);

    });

};

module.exports = TxController;
