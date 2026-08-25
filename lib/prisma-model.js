const { getPrisma } = require("../config/db");

function toPrismaFilter(filters) {
  return Object.entries(filters).reduce((where, [key, value]) => {
    if (key === "$or") {
      where.OR = value.map(toPrismaFilter);
      return where;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const condition = {};
      if ("$lte" in value) condition.lte = value.$lte;
      if ("$lt" in value) condition.lt = value.$lt;
      if ("$in" in value) condition.in = value.$in;
      where[key] = condition;
      return where;
    }

    where[key] = value;
    return where;
  }, {});
}

function addCompatibilityMethods(row, model) {
  if (!row) return row;
  Object.defineProperty(row, "_id", { value: row.id, enumerable: false });
  row.save = async () => {
    const { id, _id, save, ...data } = row;
    const saved = await model.update({ where: { id: row.id }, data });
    Object.assign(row, saved);
    return row;
  };
  return row;
}

class Query {
  constructor(model, filters) {
    this.model = model;
    this.filters = filters;
    this.orderBy = undefined;
  }

  sort(specification) {
    const [field, direction] = Object.entries(specification)[0];
    this.orderBy = { [field]: direction === 1 ? "asc" : "desc" };
    return this;
  }

  then(resolve, reject) {
    return this.model.findFirst({
      where: toPrismaFilter(this.filters),
      orderBy: this.orderBy,
    }).then((row) => resolve(addCompatibilityMethods(row, this.model)), reject);
  }
}

function createModel(modelName, defaults = {}) {
  const getModel = () => getPrisma()[modelName];
  return {
    create: (data) => { const model = getModel(); return model.create({ data: { ...defaults, ...data }}).then((row) => addCompatibilityMethods(row, model)); },
    findOne: (filters) => new Query(getModel(), filters),
    findByIdAndUpdate: (id, update) => { const model = getModel(); return model.update({ where: { id }, data: update.$set || update }).then((row) => addCompatibilityMethods(row, model)); },
    findOneAndUpdate: async (filters, update, options = {}) => {
      const model = getModel();
      const row = await model.findFirst({ where: toPrismaFilter(filters) });
      if (!row && options.upsert) {
        const filterValues = Object.entries(filters).reduce((result, [key, value]) => {
          if (!key.startsWith("$")) result[key] = value;
          return result;
        }, {});
        const created = await model.create({ data: { ...defaults, ...filterValues, ...(update.$set || update) } });
        return addCompatibilityMethods(created, model);
      }
      if (!row) return null;
      const updated = await model.update({ where: { id: row.id }, data: update.$set || update });
      return addCompatibilityMethods(updated, model);
    },
    updateMany: async (filters, update) => {
      const model = getModel();
      const result = await model.updateMany({ where: toPrismaFilter(filters), data: update.$set || update });
      return { ...result, modifiedCount: result.count };
    },
  };
}

module.exports = { createModel };
