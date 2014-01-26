/**
 * Module Dependencies.
 */

var Model = require('../loopback').Model
  , loopback = require('../loopback')
  , crypto = require('crypto')
  , CJSON = {stringify: require('canonical-json')}
  , async = require('async')
  , assert = require('assert');

/**
 * Properties
 */

var properties = {
  id: {type: String, generated: true, id: true},
  rev: {type: String},
  prev: {type: String},
  checkpoint: {type: Number},
  modelName: {type: String},
  modelId: {type: String}
};

/**
 * Options
 */

var options = {

};

/**
 * Change list entry.
 *
 * @property id {String} Hash of the modelName and id
 * @property rev {String} the current model revision
 * @property prev {String} the previous model revision
 * @property checkpoint {Number} the current checkpoint at time of the change
 * @property modelName {String}  the model name
 * @property modelId {String} the model id
 * 
 * @class
 * @inherits {Model}
 */

var Change = module.exports = Model.extend('Change', properties, options);

/*!
 * Constants 
 */

Change.UPDATE = 'update';
Change.CREATE = 'create';
Change.DELETE = 'delete';
Change.UNKNOWN = 'unknown';

/*!
 * Setup the extended model.
 */

Change.setup = function() {
  var Change = this;

  Change.getter.id = function() {
    var hasModel = this.modelName && this.modelId;
    if(!hasModel) return null;

    return Change.idForModel(this.modelName, this.modelId);
  }
}
Change.setup();


/**
 * Track the recent change of the given modelIds.
 * 
 * @param  {String}   modelName
 * @param  {Array}    modelIds
 * @callback {Function} callback
 * @param {Error} err
 * @param {Array} changes Changes that were tracked
 */

Change.track = function(modelName, modelIds, callback) {
  var tasks = [];
  var Change = this;

  modelIds.forEach(function(id) {
    tasks.push(function(cb) {
      Change.findOrCreate(modelName, id, function(err, change) {
        if(err) return Change.handleError(err, cb);
        change.rectify(cb);
      });
    });
  });
  async.parallel(tasks, callback);
}

/**
 * Get an identifier for a given model.
 * 
 * @param  {String} modelName
 * @param  {String} modelId 
 * @return {String}
 */

Change.idForModel = function(modelName, modelId) {
  return this.hash([modelName, modelId].join('-'));
}

/**
 * Find or create a change for the given model.
 *
 * @param  {String}   modelName 
 * @param  {String}   modelId   
 * @callback  {Function} callback
 * @param {Error} err
 * @param {Change} change
 * @end
 */

Change.findOrCreate = function(modelName, modelId, callback) {
  var id = this.idForModel(modelName, modelId);
  var Change = this;

  this.findById(id, function(err, change) {
    if(err) return callback(err);
    if(change) {
      callback(null, change);
    } else {
      var ch = new Change({
        id: id,
        modelName: modelName,
        modelId: modelId
      });
      ch.save(callback);
    }
  });
}

/**
 * Update (or create) the change with the current revision.
 * 
 * @callback {Function} callback
 * @param {Error} err
 * @param {Change} change
 */

Change.prototype.rectify = function(cb) {
  var change = this;
  this.prev = this.rev;
  // get the current revision
  this.currentRevision(function(err, rev) {
    if(err) return Change.handleError(err, cb);
    change.rev = rev;
    change.save(cb);
  });
}

/**
 * Get a change's current revision based on current data.
 * @callback  {Function} callback
 * @param {Error} err
 * @param {String} rev The current revision
 */

Change.prototype.currentRevision = function(cb) {
  var model = this.getModelCtor();
  model.findById(this.modelId, function(err, inst) {
    if(err) return Change.handleError(err, cb);
    if(inst) {
      cb(null, Change.revisionForInst(inst));
    } else {
      cb(null, null);
    }
  });
}

/**
 * Create a hash of the given `string` with the `options.hashAlgorithm`.
 * **Default: `sha1`**
 * 
 * @param  {String} str The string to be hashed
 * @return {String}     The hashed string
 */

Change.hash = function(str) {
  return crypto
    .createHash(Change.settings.hashAlgorithm || 'sha1')
    .update(str)
    .digest('hex');
}

/**
 * Get the revision string for the given object
 * @param  {Object} inst The data to get the revision string for
 * @return {String}      The revision string
 */

Change.revisionForInst = function(inst) {
  return this.hash(CJSON.stringify(inst));
}

/**
 * Get a change's type. Returns one of:
 *
 * - `Change.UPDATE`
 * - `Change.CREATE`
 * - `Change.DELETE`
 * - `Change.UNKNOWN`
 * 
 * @return {String} the type of change
 */

Change.prototype.type = function() {
  if(this.rev && this.prev) {
    return Change.UPDATE;
  }
  if(this.rev && !this.prev) {
    return Change.CREATE;
  }
  if(!this.rev && this.prev) {
    return Change.DELETE;
  }
  return Change.UNKNOWN;
}

/**
 * Get the `Model` class for `change.modelName`.
 * @return {Model}
 */

Change.prototype.getModelCtor = function() {
  // todo - not sure if this works with multiple data sources
  return this.constructor.modelBuilder.models[this.modelName];
}

/**
 * Compare two changes.
 * @param  {Change} change
 * @return {Boolean}
 */

Change.prototype.equals = function(change) {
  return change.rev === this.rev;
}

/**
 * Determine if the change is based on the given change.
 * @param  {Change} change
 * @return {Boolean}
 */

Change.prototype.isBasedOn = function(change) {
  return this.prev === change.rev;
}

/**
 * Determine the differences for a given model since a given checkpoint.
 *
 * The callback will contain an error or `result`.
 * 
 * **result**
 *
 * ```js
 * {
 *   deltas: Array,
 *   conflicts: Array
 * }
 * ```
 *
 * **deltas**
 *
 * An array of changes that differ from `remoteChanges`.
 * 
 * **conflicts**
 *
 * An array of changes that conflict with `remoteChanges`.
 * 
 * @param  {String}   modelName
 * @param  {Number}   since         Compare changes after this checkpoint
 * @param  {Change[]} remoteChanges A set of changes to compare
 * @callback  {Function} callback
 * @param {Error} err
 * @param {Object} result See above.
 */

Change.diff = function(modelName, since, remoteChanges, callback) {
  var remoteChangeIndex = {};
  var modelIds = [];
  remoteChanges.forEach(function(ch) {
    modelIds.push(ch.modelId);
    remoteChangeIndex[ch.modelId] = new Change(ch);
  });

  // normalize `since`
  since = Number(since) || 0;
  this.find({
    where: {
      modelName: modelName,
      modelId: {inq: modelIds},
      checkpoint: {gt: since}
    }
  }, function(err, localChanges) {
    if(err) return callback(err);
    var deltas = [];
    var conflicts = [];
    localChanges.forEach(function(localChange) {
      var remoteChange = remoteChangeIndex[localChange.modelId];
      if(!localChange.equals(remoteChange)) {
        if(remoteChange.isBasedOn(localChange)) {
          deltas.push(remoteChange);
        } else {
          conflicts.push(localChange);
        }
      }
    });

    callback(null, {
      deltas: deltas,
      conflicts: conflicts
    });
  });
}