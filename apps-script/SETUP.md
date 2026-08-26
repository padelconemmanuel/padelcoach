# Deploy del sync (Apps Script)

Esto conecta `padel-alumnos.html` con el calendario `clasesdepadel@gmail.com` en las dos direcciones: alumnos por turno, horarios, y pagos/montos (en la descripción del evento).

## 1. Crear el proyecto

1. Entrá a [script.google.com](https://script.google.com) **con la cuenta clasesdepadel@gmail.com**.
2. "Nuevo proyecto".
3. Borrá el contenido de `Code.gs` y pegá el contenido de [`Code.gs`](./Code.gs) de esta carpeta.
4. Nombrá el proyecto algo como "Sync Alumnos Padel".

## 2. Configurar el token

1. En el panel izquierdo, ícono de engranaje ("Configuración del proyecto").
2. Bajá hasta "Propiedades del script" → "Añadir propiedad del script".
3. Propiedad: `SYNC_TOKEN`. Valor: `205de26b77a091ec3da047b65bc2f9f43400e9e319dc9e83`
   (es el mismo token que ya está puesto en `padel-alumnos.html`, no hace falta cambiarlo — pero si querés generar uno propio, avisame y actualizo el archivo).

## 3. Deployar como Web App

1. Botón "Implementar" (arriba a la derecha) → "Nueva implementación".
2. Tipo: "Aplicación web".
3. "Ejecutar como": **Yo (clasesdepadel@gmail.com)**.
4. "Quién tiene acceso": **Cualquier usuario**.
5. "Implementar". Te va a pedir autorizar permisos (acceso a tu Calendar) — aceptá con la cuenta clasesdepadel@gmail.com.
6. Copiá la **URL de la aplicación web** que te da (termina en `/exec`).

## 4. Activar el sync periódico (opcional pero recomendado)

1. Ícono de reloj ("Disparadores") en el panel izquierdo.
2. "Añadir disparador".
3. Función: `syncTick`. Origen del evento: "Basado en tiempo". Tipo: "Temporizador de minutos". Cada 15 minutos (o el intervalo que prefieras).
4. Guardar (te va a pedir autorizar de nuevo si es la primera vez).

Esto hace que la reconciliación corra sola aunque nadie tenga la página abierta — por ejemplo, si agregás o borrás un turno directo en Google Calendar.

## 5. Conectar la página

Mandame la URL que copiaste en el paso 3 (la que termina en `/exec`). Yo actualizo la constante `SYNC_URL` en `padel-alumnos.html` y subo el cambio a GitHub.

## Cómo funciona (resumen)

- El calendario es la fuente de verdad para **quién está en cada turno** y **el horario**.
- La página es la fuente de verdad para **pagos y montos** (el calendario no tiene ese concepto — se guardan en la descripción del evento como texto informativo).
- Cada clase (turno) queda taggeada en la descripción del evento con `[alumnos:ID]` para poder identificarla de forma estable aunque cambien nombres u horarios.
- Los eventos con el texto "reserva" en el título se ignoran (no son clases con alumnos).
- Si agregás un alumno o cambiás el horario en la página, se sube al calendario apenas dejás de tipear (con ~1 segundo de espera).
- Si agregás/borrás un evento directo en Google Calendar, se refleja en la página la próxima vez que la abras (o cada 15 min, si configuraste el disparador).
- Si ambos lados cambian lo mismo entre sincronizaciones (raro), gana lo que esté en la página.
