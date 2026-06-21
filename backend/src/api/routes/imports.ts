import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requirePlan, trackUsageAfter } from '../../billing/middleware/plan-enforcer';
import {
  startImport, generatePreview, commitImport,
  getImport, listImports,
} from '../../services/import.service';
import { uploadFile } from '../../services/storage.service';
import { config } from '../../shared/config';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.imports.maxFileSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only CSV and Excel files are supported'));
  },
});

// GET /imports
router.get('/', async (req, res, next) => {
  try {
    const imports = await listImports(req.auth.tenant_id);
    res.json({ success: true, data: imports });
  } catch (err) { next(err); }
});

// POST /imports/upload — upload file + start import record
router.post('/upload', upload.single('file'), requirePlan('imports_started'), trackUsageAfter('imports_started'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    const { source_type, name } = z.object({
      source_type: z.enum(['csv','excel','salesforce','hubspot','followupboss','kvcore','manual']),
      name: z.string().min(1).default('Import'),
    }).parse(req.body);

    const { path: filePath } = await uploadFile(
      req.auth.tenant_id,
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype,
    );

    const importRecord = await startImport(req.auth.tenant_id, req.auth.user_id, {
      name: name || req.file.originalname,
      sourceType: source_type,
      filePath,
      originalFilename: req.file.originalname,
      fileSize: req.file.size,
    });

    res.status(201).json({ success: true, data: importRecord });
  } catch (err) { next(err); }
});

// POST /imports/:id/preview
router.post('/:id/preview', async (req, res, next) => {
  try {
    const result = await generatePreview(req.auth.tenant_id, req.params.id);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// POST /imports/:id/commit
router.post('/:id/commit', async (req, res, next) => {
  try {
    const { field_mapping } = z.object({
      field_mapping: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const result = await commitImport(
      req.auth.tenant_id,
      req.params.id,
      req.auth.user_id,
      field_mapping,
    );
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// GET /imports/:id
router.get('/:id', async (req, res, next) => {
  try {
    const importRecord = await getImport(req.auth.tenant_id, req.params.id);
    res.json({ success: true, data: importRecord });
  } catch (err) { next(err); }
});

export default router;
