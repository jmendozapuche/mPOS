# mPOS: demo con lector i9

Herramientas para usar el lector **i9** (Shenzhen HCC, "3 in 1 NFC card reader") en demostraciones contra un switch transaccional y un sistema de adquirencia de prueba.

- `web/i9-console.html`: consola Web Bluetooth. Se conecta al i9, muestra la información del terminal y la batería, inicia un cobro (banda, chip o NFC), interpreta la respuesta (TLV del lector y campo 55 EMV) y la copia como JSON.
- `docs/PROTOCOLO_I9.md`: resumen del protocolo del fabricante, con los UUID BLE, el formato de trama, los comandos y las llaves de depuración.

## Uso rápido

La consola necesita Chrome y un contexto seguro (HTTPS o `localhost`):

```bash
cd web && python3 -m http.server 8000
# abrir http://localhost:8000/i9-console.html en Chrome
```

En Android, sírvala por HTTPS (por ejemplo con GitHub Pages o un túnel) o use `chrome://inspect` con reenvío de puertos hacia `localhost`.

El SDK oficial (apps Android, iOS y Windows, más los PDF) se obtiene del fabricante y no se incluye en este repositorio.
