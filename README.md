# PulsePlay MVP

Plataforma web de participación en vivo inspirada en Kahoot y Mentimeter.

## Funcionalidades actuales

- Registro, confirmación de correo, inicio de sesión y recuperación con Supabase Auth.
- Perfiles y espacios de trabajo separados por cuenta.
- Creación y persistencia de actividades en Supabase.
- Trivia, encuesta, nube de palabras, respuesta abierta, escala y ranking.
- Tiempos configurables, incluida la opción sin límite.
- Sesiones en vivo entre dispositivos, resultados y leaderboard competitivo.
- Historial con participantes, puntajes y respuestas por pregunta.
- Biblioteca con búsqueda, orden y paginación.
- Códigos de sala generados al iniciar una presentación.

## Desarrollo local

```powershell
node server.mjs
```

Abrir `http://127.0.0.1:5173/`.

## Supabase

Las migraciones se encuentran en `supabase/migrations/`. La clave incluida en
`config.js` es una clave pública de frontend; las políticas RLS protegen los
datos privados.

### Configuración de autenticación

En Supabase, configura `Authentication > URL Configuration` con:

- Site URL: `https://migueiturra.github.io/pulseplay/`
- Redirect URL: `https://migueiturra.github.io/pulseplay/**`
- Redirect URL local: `http://127.0.0.1:5173/**`

La plantilla en español para el correo de confirmación está en
`supabase/email-templates/confirmation.html`. En `Authentication > Email
Templates > Confirm signup`, usa el asunto `Confirma tu cuenta de PulsePlay` y
pega ese HTML.

Para Google, crea un cliente OAuth web y registra como URI autorizada:

`https://resyhvhanfphfxwgaxlz.supabase.co/auth/v1/callback`

Luego activa Google en `Authentication > Sign In / Providers` de Supabase con
el Client ID y Client Secret obtenidos.

## Despliegue

Cada actualización de la rama `main` ejecuta el workflow de GitHub Pages.
