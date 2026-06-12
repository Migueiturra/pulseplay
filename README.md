# PulsePlay MVP

Plataforma web de participación en vivo inspirada en Kahoot y Mentimeter.

## Funcionalidades actuales

- Registro, confirmación de correo, inicio de sesión y recuperación con Supabase Auth.
- Perfiles y espacios de trabajo separados por cuenta.
- Creación y persistencia de actividades en Supabase.
- Trivia, encuesta, nube de palabras, respuesta abierta, escala y ranking.
- Tiempos configurables, incluida la opción sin límite.
- Presentación, resultados y leaderboard competitivo.
- Biblioteca con búsqueda, orden y paginación.
- Códigos de sala generados al iniciar una presentación.

Las sesiones en vivo todavía utilizan almacenamiento local, por lo que la
participación entre dispositivos diferentes será parte de la siguiente etapa con
Supabase Realtime.

## Desarrollo local

```powershell
node server.mjs
```

Abrir `http://127.0.0.1:5173/`.

## Supabase

Las migraciones se encuentran en `supabase/migrations/`. La clave incluida en
`config.js` es una clave pública de frontend; las políticas RLS protegen los
datos privados.

## Despliegue

Cada actualización de la rama `main` ejecuta el workflow de GitHub Pages.
