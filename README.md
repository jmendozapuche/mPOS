# mPOS: demo con lector i9

Herramientas para usar el lector **i9** (Shenzhen HCC, "3 in 1 NFC card reader") en demostraciones contra un switch transaccional y un sistema de adquirencia de prueba.

- `web/pos.html`: **pantalla de cobro para el comercio**. Tiene teclado de monto en pesos, cobro con el lector i9, resultado aprobado o rechazado, recibo (para imprimir o compartir), ventas del día y anulación. Incluye un modo demo con tarjeta simulada.
- `web/i9.js`: librería del lector que usa `pos.html` (conexión BLE, transacción `02 A0`, confirmación al chip `02 A1`).
- `web/i9-console.html`: consola Web Bluetooth. Se conecta al i9, muestra la información del terminal y la batería, inicia un cobro (banda, chip o NFC), interpreta la respuesta (TLV del lector y campo 55 EMV) y la copia como JSON.
- `bridge/svfe-bridge.js`: puente HTTP → ISO 8583 para **SmartVista FE (POS Trickle Feed EMV, v1.89)**. Arma 0800 (eco), 0200 (compra) y 0400 (reverso, también automático si el switch no responde a tiempo), y trae un simulador SVFE (`--mock`). No tiene dependencias: solo necesita Node.js 18 o superior.
- `docs/PROTOCOLO_I9.md`: resumen del protocolo del fabricante, con los UUID BLE, el formato de trama, los comandos y las llaves de depuración.

## Pantalla de cobro

1. Inicie el puente (vea "Conectar con el switch SmartVista").
2. Abra `https://<usuario>.github.io/mPOS/web/pos.html` en Chrome.
3. En **Ajustes**: conecte el lector y escriba el nombre del comercio, el NIT, la URL del puente y el TID/MID. Pruebe el eco.
4. En **Cobrar**: digite el monto, toque *Cobrar* y acerque, inserte o deslice la tarjeta.

El historial guarda solo datos enmascarados (marca, últimos 4 dígitos, autorización, RRN), y solo en el navegador. Para anular se envía un 0400 con el STAN y el RRN de la venta; funciona mientras el puente siga corriendo desde que se hizo la venta.

## Uso rápido (consola técnica)

La consola necesita Chrome y un contexto seguro (HTTPS o `localhost`):

```bash
cd web && python3 -m http.server 8000
# abrir http://localhost:8000/i9-console.html en Chrome
```

En Android, sírvala por HTTPS (por ejemplo con GitHub Pages o un túnel) o use `chrome://inspect` con reenvío de puertos hacia `localhost`.

El SDK oficial (apps Android, iOS y Windows, más los PDF) se obtiene del fabricante y no se incluye en este repositorio.

## Conectar con el switch SmartVista

El navegador no puede abrir conexiones TCP, así que la consola le habla por HTTP al puente y el puente le habla por ISO 8583 al switch.

```
Lector i9 ──BLE──> Consola (Chrome) ──HTTP──> svfe-bridge.js ──TCP ISO 8583──> SmartVista FE
```

1. Pruebe primero con el simulador:
   ```bash
   node bridge/svfe-bridge.js --mock --tid 00010001 --mid 123456789012345
   ```
   El simulador aprueba todo, salvo los montos terminados en ,51, que devuelve con DE39 116 (fondos insuficientes).
2. Después, contra el switch real:
   ```bash
   node bridge/svfe-bridge.js --switch IP:PUERTO --tid SU_TID --mid SU_MID --currency 170
   ```
   | Opción | Para qué | Por defecto |
   |---|---|---|
   | `--header bin2\|ascii4\|none` | Encabezado de longitud del mensaje | `bin2` (2 bytes big endian) |
   | `--tpdu HEX` | TPDU antes del MTI, si su SVFE lo usa | sin TPDU |
   | `--link` | Nivel de enlace ENQ/ACK/DLE-EOT | apagado |
   | `--f55len ascii\|bcd` | Longitud del DE55: `LLL` ASCII o `0LLL` BCD | `ascii` |
   | `--timeout 30` | Segundos de espera antes del reverso automático | 30 |

   La especificación no fija el encabezado de longitud ni el formato de la longitud del DE55. Confírmelos con quien administra el switch.

### Cómo llega la consola al puente

La consola, servida en HTTPS desde GitHub Pages, puede llamar a `http://localhost:8080`, pero no a otra IP. Hay tres formas de lograrlo:
- **Laptop con Bluetooth:** corra el puente y abra la consola en Chrome en la misma laptop.
- **Teléfono Android + PC por USB:** en la PC abra `chrome://inspect`, entre a *Port forwarding* y agregue `8080 → localhost:8080`. El teléfono verá el puente como `localhost:8080`.
- **Teléfono Android solo:** instale Termux, ejecute `pkg install nodejs` y corra el puente en el teléfono. El teléfono debe poder alcanzar el switch, por ejemplo por VPN.

### Datos que se envían en el 0200

| DE | Valor |
|---|---|
| 3 | `000000` |
| 4 | Monto en centavos |
| 7 | Fecha y hora GMT |
| 11 | STAN (se guarda en `bridge/.stan`) |
| 12 | Fecha y hora local |
| 22 | `070` sin contacto EMV, `050` chip, `910` sin contacto con banda, `020` banda; la tercera posición es 1 si hubo PIN |
| 24 | `200` |
| 25 | `00` |
| 35 | Pista 2 (del lector o del tag 57) |
| 41 | TID |
| 42 | MID |
| 49 | `170` |
| 55 | Solo los tags EMV que admite SVFE (sin 57 ni 5F20) |

Limitaciones actuales:
- No calcula MAC (DE64). Hay que deshabilitarlo en el switch para este terminal de prueba o agregar la llave MAC.
- Si el lector envía 5F2A o 9F1A en `0000`, el puente los reemplaza por 0170 y lo avisa. El ARQC ya se calculó con 0000, así que un emisor que valide el criptograma rechazará la transacción. Pruebe el botón **"1F09 = Colombia"** de la consola para que el lector use 0170 desde el principio.
