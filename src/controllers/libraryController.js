const svc = require("../services/libraryService");

const wrap = (fn) => async (req, res, next) => {
  try {
    const data = await fn(req);
    if (data === undefined) return res.status(204).end();
    return res.status(200).json({ data });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  // categories
  getCategories: wrap(() => svc.listCategories()),
  postCategory: wrap((req) => svc.createCategory(req.body || {})),
  patchCategory: wrap((req) => svc.updateCategory(req.params.id, req.body || {})),
  deleteCategory: wrap(async (req) => {
    await svc.deleteCategory(req.params.id);
    return { ok: true };
  }),

  // sub-categories
  getSubCategories: wrap((req) => svc.listSubCategories({ categoryId: req.query.category_id })),
  postSubCategory: wrap((req) => svc.createSubCategory(req.body || {})),
  patchSubCategory: wrap((req) => svc.updateSubCategory(req.params.id, req.body || {})),
  deleteSubCategory: wrap(async (req) => {
    await svc.deleteSubCategory(req.params.id);
    return { ok: true };
  }),

  // tags
  getTags: wrap(() => svc.listTags()),
  postTag: wrap((req) => svc.createTag(req.body || {})),
  patchTag: wrap((req) => svc.updateTag(req.params.id, req.body || {})),
  deleteTag: wrap(async (req) => {
    await svc.deleteTag(req.params.id);
    return { ok: true };
  }),

  // flag taxonomy (surfaced as Category / Sub Category in the Library UI)
  getFlagCategories: wrap(() => svc.listFlagCategories()),
  getFlags: wrap((req) => svc.listFlags({ flagCategoryId: req.query.flag_category_id })),
  getFlagCatalog: wrap(() => svc.listFlagCatalog()),
};
