// server.js - API de Aura (etapa 2: lectura + login + citas + horarios ocupados)
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- helpers ----------
// Si una ruta truena, responde 500 en JSON en vez de colgarse
const wrap = (fn) => (req, res, next) =>
  fn(req, res, next).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

// Swift (.iso8601) NO acepta milisegundos: "2026-12-03T10:30:00Z"
const isoSinMs = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

const nuevoId = (prefijo) => `${prefijo}-${crypto.randomBytes(4).toString('hex')}`;

const correoValido = (c) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c);

// ¿El error de MySQL es por horario ocupado?
const esHorarioOcupado = (err) =>
  err && err.code === 'ER_DUP_ENTRY' && String(err.sqlMessage).includes('uq_citas_horario_ocupado');

const usuarioPublico = (u) => ({
  id: u.id,
  nombre: u.nombre,
  correo: u.correo,
  telefono: (u.telefono ?? '').trim()
});

const SQL_CITA = `
  SELECT c.id, c.servicio, c.motivo, c.especialista_id,
         e.nombre AS especialista, e.especialidad,
         c.fecha, c.estado, c.notas
  FROM citas c
  JOIN especialistas e ON e.id = c.especialista_id`;

const citaDTO = (c) => ({
  id: c.id,
  servicio: c.servicio,
  motivo: c.motivo,
  especialistaId: c.especialista_id,
  especialista: c.especialista,
  especialidad: c.especialidad,
  fecha: isoSinMs(c.fecha),
  estado: c.estado,
  notas: c.notas ?? ''
});

// Identifica a la paciente con el encabezado X-Usuario-Id
const requiereUsuario = wrap(async (req, res, next) => {
  const id = (req.get('X-Usuario-Id') || '').trim();
  if (!id) return res.status(401).json({ error: 'Falta el encabezado X-Usuario-Id' });
  const [rows] = await pool.query('SELECT id FROM usuarios WHERE id = ?', [id]);
  if (rows.length === 0) return res.status(401).json({ error: 'Usuario no válido' });
  req.usuarioId = id;
  next();
});

const router = express.Router();

// =====================================================
//  LECTURA
// =====================================================
router.get('/especialistas', wrap(async (req, res) => {
  const [esps] = await pool.query('SELECT * FROM especialistas WHERE activo = TRUE ORDER BY id');
  const [servs] = await pool.query(
    'SELECT especialista_id, nombre, precio FROM especialista_servicios ORDER BY orden, id'
  );
  res.json(
    esps.map((e) => ({
      id: e.id,
      initials: e.initials,
      nombre: e.nombre,
      especialidad: e.especialidad,
      cedulaCarrera: e.cedula_carrera,
      cedulaEspecialidad: e.cedula_especialidad,
      aniosExperiencia: e.anios_experiencia,
      disponibilidad: e.disponibilidad,
      bio: e.bio,
      fotoURL: e.foto_url,
      servicios: servs
        .filter((s) => s.especialista_id === e.id)
        .map((s) => ({ nombre: s.nombre, precio: s.precio }))
    }))
  );
}));

// Horarios ocupados de una doctora entre dos fechas (ISO 8601).
// Ej: /v1/especialistas/esp-1/ocupados?desde=2026-12-03T06:00:00Z&hasta=2026-12-04T06:00:00Z
router.get('/especialistas/:id/ocupados', wrap(async (req, res) => {
  const desde = new Date(req.query.desde);
  const hasta = new Date(req.query.hasta);
  if (isNaN(desde) || isNaN(hasta)) {
    return res.status(400).json({ error: 'Manda desde y hasta en formato ISO 8601' });
  }
  const [rows] = await pool.query(
    `SELECT fecha FROM citas
     WHERE especialista_id = ? AND slot_activo IS NOT NULL
       AND fecha >= ? AND fecha < ?
     ORDER BY fecha`,
    [req.params.id, desde, hasta]
  );
  res.json(rows.map((r) => isoSinMs(r.fecha)));
}));

router.get('/servicios', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM servicios ORDER BY id');
  res.json(
    rows.map((s) => ({
      id: s.id,
      motivo: s.motivo,
      especialistaId: s.especialista_id,
      nombre: s.nombre,
      categoria: s.categoria,
      duracionMin: s.duracion_min,
      precio: s.precio,
      resumen: s.resumen,
      descripcion: s.descripcion,
      preparacion: s.preparacion
    }))
  );
}));

router.get('/clinica', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM clinica WHERE id = 1');
  if (rows.length === 0) return res.status(404).json({ error: 'Clínica no encontrada' });
  const c = rows[0];
  const [horarios] = await pool.query('SELECT dias, horas FROM clinica_horarios ORDER BY orden');
  res.json({
    nombre: c.nombre,
    descripcion: c.descripcion,
    registroSanitario: c.registro_sanitario,
    horarios,
    telefono: c.telefono,
    whatsapp: c.whatsapp,
    correo: c.correo,
    instagram: c.instagram,
    direccion: c.direccion,
    latitud: Number(c.latitud),   // MySQL regresa los DECIMAL como texto; la app espera número
    longitud: Number(c.longitud)
  });
}));

// =====================================================
//  AUTH
// =====================================================
router.post('/auth/registro', wrap(async (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || '').trim();
  const correo = String(b.correo || '').trim().toLowerCase();
  const telefono = String(b.telefono || '').replace(/\D/g, ''); // solo dígitos
  const password = String(b.password || '');

  if (nombre.length < 3) return res.status(400).json({ error: 'Ingresa tu nombre completo' });
  if (!correoValido(correo)) return res.status(400).json({ error: 'El correo no es válido' });
  if (telefono.length !== 10) return res.status(400).json({ error: 'El teléfono debe tener 10 dígitos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  const [existe] = await pool.query('SELECT id FROM usuarios WHERE correo = ?', [correo]);
  if (existe.length > 0) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

  const id = nuevoId('usr');
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    'INSERT INTO usuarios (id, nombre, correo, telefono, password_hash) VALUES (?, ?, ?, ?, ?)',
    [id, nombre, correo, telefono, hash]
  );
  res.status(201).json(usuarioPublico({ id, nombre, correo, telefono }));
}));

router.post('/auth/login', wrap(async (req, res) => {
  const b = req.body || {};
  const correo = String(b.correo || '').trim().toLowerCase();
  const password = String(b.password || '');

  const [rows] = await pool.query('SELECT * FROM usuarios WHERE correo = ?', [correo]);
  const u = rows[0];
  const ok = u && (await bcrypt.compare(password, u.password_hash));
  if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });

  res.json(usuarioPublico(u));
}));

router.post('/auth/logout', (req, res) => res.json({ ok: true }));

// =====================================================
//  CITAS (requieren X-Usuario-Id)
// =====================================================
router.get('/citas', requiereUsuario, wrap(async (req, res) => {
  const [rows] = await pool.query(
    `${SQL_CITA} WHERE c.usuario_id = ? ORDER BY c.fecha ASC`,
    [req.usuarioId]
  );
  res.json(rows.map(citaDTO));
}));

router.post('/citas', requiereUsuario, wrap(async (req, res) => {
  const b = req.body || {};
  const servicio = String(b.servicio || '').trim();
  const motivo = String(b.motivo || '').trim();
  const fecha = new Date(b.fecha);

  if (!servicio || !motivo || !b.especialistaId || isNaN(fecha)) {
    return res.status(400).json({ error: 'Faltan datos de la cita' });
  }

  const [esp] = await pool.query('SELECT id FROM especialistas WHERE id = ?', [b.especialistaId]);
  if (esp.length === 0) return res.status(400).json({ error: 'La especialista no existe' });

  // Usa el id que manda la app; si ya existe o no es válido, genera uno
  let id = typeof b.id === 'string' && /^[\w-]{1,20}$/.test(b.id) ? b.id : nuevoId('cita');
  const [yaExiste] = await pool.query('SELECT id FROM citas WHERE id = ?', [id]);
  if (yaExiste.length > 0) id = nuevoId('cita');

  try {
    await pool.query(
      `INSERT INTO citas (id, usuario_id, servicio, motivo, especialista_id, fecha, estado, notas)
       VALUES (?, ?, ?, ?, ?, ?, 'Confirmada', ?)`,
      [id, req.usuarioId, servicio, motivo, b.especialistaId, fecha, b.notas || '']
    );
  } catch (err) {
    if (esHorarioOcupado(err)) {
      return res.status(409).json({ error: 'Ese horario ya está ocupado. Elige otro.' });
    }
    throw err;
  }

  const [rows] = await pool.query(`${SQL_CITA} WHERE c.id = ?`, [id]);
  res.status(201).json(citaDTO(rows[0]));
}));

router.patch('/citas/:id/cancelar', requiereUsuario, wrap(async (req, res) => {
  const [cita] = await pool.query(
    'SELECT id FROM citas WHERE id = ? AND usuario_id = ?',
    [req.params.id, req.usuarioId]
  );
  if (cita.length === 0) return res.status(404).json({ error: 'Cita no encontrada' });

  await pool.query("UPDATE citas SET estado = 'Cancelada' WHERE id = ?", [req.params.id]);
  const [rows] = await pool.query(`${SQL_CITA} WHERE c.id = ?`, [req.params.id]);
  res.json(citaDTO(rows[0]));
}));

router.patch('/citas/:id/reagendar', requiereUsuario, wrap(async (req, res) => {
  const fecha = new Date((req.body || {}).fecha);
  if (isNaN(fecha)) return res.status(400).json({ error: 'La nueva fecha no es válida' });

  const [cita] = await pool.query(
    'SELECT id FROM citas WHERE id = ? AND usuario_id = ?',
    [req.params.id, req.usuarioId]
  );
  if (cita.length === 0) return res.status(404).json({ error: 'Cita no encontrada' });

  try {
    await pool.query(
      "UPDATE citas SET fecha = ?, estado = 'Reagendada' WHERE id = ?",
      [fecha, req.params.id]
    );
  } catch (err) {
    if (esHorarioOcupado(err)) {
      return res.status(409).json({ error: 'Ese horario ya está ocupado. Elige otro.' });
    }
    throw err;
  }

  const [rows] = await pool.query(`${SQL_CITA} WHERE c.id = ?`, [req.params.id]);
  res.json(citaDTO(rows[0]));
}));

// La app llama a  .../v1/...
app.use('/v1', router);

app.get('/', (req, res) => res.json({ api: 'Aura', estado: 'en línea' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API de Aura escuchando en el puerto ${PORT}`));