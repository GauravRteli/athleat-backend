const express = require("express");
const c = require("../controllers/libraryController");

const router = express.Router();

router.get("/categories", c.getCategories);
router.post("/categories", c.postCategory);
router.patch("/categories/:id", c.patchCategory);
router.delete("/categories/:id", c.deleteCategory);

router.get("/sub-categories", c.getSubCategories);
router.post("/sub-categories", c.postSubCategory);
router.patch("/sub-categories/:id", c.patchSubCategory);
router.delete("/sub-categories/:id", c.deleteSubCategory);

router.get("/tags", c.getTags);
router.post("/tags", c.postTag);
router.patch("/tags/:id", c.patchTag);
router.delete("/tags/:id", c.deleteTag);

// Flag taxonomy (surfaced as Category / Sub Category in the Library UI).
// These are read-only and unauthenticated so the Kerry dashboard can use
// them without an athlete token.
router.get("/flag-categories", c.getFlagCategories);
router.get("/flags", c.getFlags);
router.get("/flag-catalog", c.getFlagCatalog);

module.exports = router;
