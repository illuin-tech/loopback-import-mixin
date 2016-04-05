/**
 * Stats Mixin Dependencies
 */
import async from 'async';
import moment from 'moment';
import childProcess from 'child_process';
import csv from 'csv-parser';
import fs from 'fs';
// import DataSourceBuilder from './builders/datasource-builder';
/**
  * Bulk Import Mixin
  * @Author Jonathan Casarrubias
  * @See <https://twitter.com/johncasarrubias>
  * @See <https://www.npmjs.com/package/loopback-import-mixin>
  * @See <https://github.com/jonathan-casarrubias/loopback-import-mixin>
  * @Description
  *
  * The following mixin will add bulk importing functionallity to models which includes
  * this module.
  *
  * Default Configuration
  *
  * "Import": {
  *   "models": {
  *     "ImportContainer": "Model",
  *     "ImportLog": "Model"
  *   }
  * }
  **/
export default (Model, ctx) => {
  // Create import method
  Model.import = (req, finish) => {
    // Set model names
    const ImportContainerName = (ctx.models && ctx.models.ImportContainer) || 'ImportContainer';
    const ImportLogName = (ctx.models && ctx.models.ImportLog) || 'ImportLog';
    const ImportContainer = Model.app.models[ImportContainerName];
    const ImportLog = Model.app.models[ImportLogName];
    const containerName = Model.definition.name + '-' + Math.round(Date.now()) + '-' + Math.round(Math.random() * 1000);
    if (!ImportContainer || !ImportLog) {
      return finish(new Error('(loopback-import-mixin) Missing required models, verify your setup and configuration'));
    }
    return new Promise((resolve, reject) => {
      async.waterfall([
        // Create container
        next => ImportContainer.createContainer({ name: containerName }, next),
        // Upload File
        (container, next) => {
          req.params.container = containerName;
          ImportContainer.upload(req, {}, next);
        },
        // Persist process in db and run in fork process
        (fileContainer, next) => {
          if (fileContainer.files.file[0].type !== 'text/csv') {
            ImportContainer.destroyContainer(containerName);
            return next(new Error('The file you selected is not csv format'));
          }
          // Store the state of the import process in the database
          ImportLog.create({
            date: moment().toISOString(),
            model: Model.definition.name,
            status: 'PENDING',
          }, (err, fileUpload) => next(err, fileContainer, fileUpload));
        },
      ], (err, fileContainer, fileUpload) => {
        if (err) {
          if (typeof finish === 'function') finish(err, fileContainer);
          return reject(err);
        }
        // Launch a fork node process that will handle the import
        childProcess.fork(__dirname + '/processes/import-process.js', [
          JSON.stringify({
            scope: Model.definition.name,
            fileUploadId: fileUpload.id,
            root: Model.app.datasources.container.settings.root,
            container: fileContainer.files.file[0].container,
            file: fileContainer.files.file[0].name,
            ImportContainer: ImportContainerName,
            ImportLog: ImportLogName,
          })]);
        if (typeof finish === 'function') finish(null, fileContainer);
        resolve(fileContainer);
      });
    });
  };
  /**
   * Create import method (Not Available through REST)
   **/
  Model.importProcessor = function ImportMethod(container, file, options, finish) {
    const filePath = '../../' + options.root + '/' + options.container + '/' + options.file;
    // const ImportContainer = Model.app.models[options.ImportContainer];
    const ImportLog = Model.app.models[options.ImportLog];
    async.waterfall([
      // Get ImportLog
      next => ImportLog.findById(options.fileUploadId, next),
      // Set importUpload status as processing
      (importLog, next) => {
        ctx.importLog = importLog;
        ctx.importLog.status = 'PROCESSING';
        ctx.importLog.save(next);
      },
      // Import Data
      (importLog, next) => {
        // This line opens the file as a readable stream
        const series = [];
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', row => {
            const obj = {};
            for (const key in ctx.map) {
              if (row[ctx.map[key]]) {
                obj[key] = row[ctx.map[key]];
              }
            }
            if (!obj[ctx.pk]) return;
            const query = {};
            query[ctx.pk] = obj[ctx.pk];
            // Lets set each row a flow
            series.push(nextSerie => {
              async.waterfall([
                // See in DB for existing persisted instance
                nextFall => Model.findOne({ where: query }, nextFall),
                // If we get an instance we just set a warning into the log
                (instance, nextFall) => {
                  if (instance) {
                    ctx.importLog.warnings = Array.isArray(ctx.importLog.warnings) ? ctx.importLog.warnings : [];
                    ctx.importLog.warnings.push({
                      row: row,
                      message: Model.definition.name + '.' + ctx.pk + ' ' + obj[ctx.pk] + ' already exists, updating fields to new values.',
                    });
                    for (const _key in obj) {
                      if (obj.hasOwnProperty(_key)) instance[_key] = obj[_key];
                    }
                    instance.save(nextFall);
                  } else {
                    nextFall(null, null);
                  }
                },
                // Otherwise we create a new instance
                (instance, nextFall) => {
                  if (instance) return nextFall(null, instance);
                  Model.create(obj, nextFall);
                },
                // Work on relations
                (instance, nextFall) => {
                  // Finall parallel process container
                  const parallel = [];
                  let setupRelation;
                  let ensureRelation;
                  // Iterates through existing relations in model
                  setupRelation = function sr(expectedRelation) {
                    for (const existingRelation in Model.definition.settings.relations) {
                      if (Model.definition.settings.relations.hasOwnProperty(existingRelation)) {
                        ensureRelation(expectedRelation, existingRelation);
                      }
                    }
                  };
                  // Makes sure the relation exist
                  ensureRelation = function er(expectedRelation, existingRelation) {
                    if (expectedRelation === existingRelation) {
                      parallel.push(nextParallel => {
                        const relQry = { where: {} };
                        for (const property in ctx.relations[expectedRelation]) {
                          if (ctx.relations[expectedRelation].hasOwnProperty(property)) {
                            relQry.where[property] = row[ctx.relations[expectedRelation][property]];
                          }
                        }
                        Model.app.models[Model.definition.settings.relations[existingRelation].model].findOne(relQry, (relErr, relInstance) => {
                          if (relErr) return nextParallel(relErr);
                          if (!relInstance) {
                            ctx.importLog.warnings = Array.isArray(ctx.importLog.warnings) ? ctx.importLog.warnings : [];
                            ctx.importLog.warnings.push({
                              row: row,
                              message: Model.definition.name + '.' + expectedRelation + ' tried to relate unexisting instance of ' + expectedRelation,
                            });
                            return nextParallel();
                          }
                          instance[expectedRelation].findById(relInstance.id, (relErr2, exist) => {
                            if (exist) {
                              ctx.importLog.warnings = Array.isArray(ctx.importLog.warnings) ? ctx.importLog.warnings : [];
                              ctx.importLog.warnings.push({
                                row: row,
                                message: Model.definition.name + '.' + expectedRelation + ' tried to relate existing relation.',
                              });
                              return nextParallel();
                            }
                            // TODO, Verify for different type of relations, this works on hasManyThrough and HasManyAndBelongsTo
                            // but what about just hast many?? seems weird but Ill left this here if any issues are rised
                            instance[expectedRelation].add(relInstance, nextParallel);
                          });
                        });
                      });
                    }
                  };
                  // Work on defined relationships
                  for (const ers in ctx.relations) {
                    if (ctx.relations.hasOwnProperty(ers)) {
                      setupRelation(ers);
                    }
                  }
                  // Run the relations process in parallel
                  async.parallel(parallel, nextFall);
                },
                // If there are any error in this serie we log it into the errors array of objects
              ], err => {
                if (err) {
                  ctx.importLog.errors = Array.isArray(ctx.importLog.errors) ? ctx.importLog.errors : [];
                  ctx.importLog.errors.push({ row: row, message: err });
                }
                nextSerie();
              });
            });
          })
          .on('end', () => {
            async.series(series, next);
          });
      },
      // Remove Container
      // next => ImportContainer.destroyContainer({ container: options.container }, next),
      // Set status as finished
      next => {
        ctx.importLog.status = 'FINISHED';
        ctx.importLog.save(next);
      },
    ], err => {
      if (err) throw new Error(err);
      finish(err);
    });
  };
  /**
   * Register Import Method
   */
  Model.remoteMethod('import', {
    http: { path: '/import', verb: 'post' },
    accepts: [{
      arg: 'req',
      type: 'object',
      http: { source: 'req' },
    }],
    returns: { type: 'object', root: true },
    description: 'Bulk upload and import cvs file to persist new instances',
  });
};