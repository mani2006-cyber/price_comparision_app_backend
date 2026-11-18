'use strict';
const { AppError } = require('../utils/errors');

/** validate(schema, 'body' | 'query' | 'params'). Replaces the request part with the parsed (typed, stripped) value. */
const validate = (schema, part = 'body') => (req, res, next) => {
  const r = schema.safeParse(req[part]);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || part}: ${i.message}`).slice(0, 5).join('; ');
    return next(new AppError(400, msg, 'VALIDATION'));
  }
  req[part] = r.data;
  return next();
};
module.exports = { validate };
