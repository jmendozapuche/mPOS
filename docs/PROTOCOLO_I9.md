# Lector i9: resumen del protocolo

Fuente: SDK oficial de Shenzhen HCC Technology (`I9_M6PLUS Ble SDK 20211214`), en especial el documento *i9 UART V2.1 English.pdf* y la app de ejemplo `I9BleDemo`. Este resumen solo sirve para **demostraciones y pruebas**.

Hardware de este equipo: `i9-200-BSO-MCR-L-1`. Lee banda magnética, chip EMV y NFC, y se conecta por BLE 4.2 o micro-USB.

## Bluetooth LE

Usa el servicio "transparent UART" de Microchip/ISSC:

| Uso | UUID |
|---|---|
| Servicio | `49535343-FE7D-4AE5-8FA9-9FAFD205E455` |
| Escribir (teléfono → i9) | `49535343-8841-43F4-A8D4-ECBE34729BB3` |
| Notificar (i9 → teléfono) | `49535343-1E4D-4BD9-BA61-23C647249616` |

Las tramas se escriben en trozos de 20 bytes. El nombre Bluetooth suele tener la forma `itXXXX`.

## Trama

```
Cabecera  Longitud(2, big endian)  Versión  Datos  Checksum
'M' 0x4D  = versión + datos        0x00     ...    XOR de todos los bytes anteriores (incluye cabecera)
'm' 0x6D  en las respuestas del terminal
```

- Datos de un comando: `primario(1) secundario(1) espera_s(1) longitud(2) datos`
- Datos de una respuesta: `primario(1) secundario(1) código(1) longitud(2) datos`

Ejemplo del documento para pedir la información del terminal: `4D 00 06 00 09 1B 10 00 00 49`.

## Comandos útiles

| Comando | Función |
|---|---|
| `09 1B` | Información del terminal: SN, versiones, nombre y MAC Bluetooth, TUSN |
| `09 13` | Voltaje de batería (mV) |
| `09 31` / `09 32` | Fijar / leer el reloj |
| `09 07` | Cancelar la transacción en curso |
| `09 FF` | Eco |
| `02 A0` | **Transacción**: banda, chip o NFC |
| `02 A1` | Devolver al chip el campo 55 de la respuesta del emisor (segunda generación del criptograma) |
| `02 E0` / `E1` / `E2` | Activar o cerrar NFC/IC y enviar APDU transparentes |
| `02 04` / `02 06` | Cifrar datos / calcular MAC |
| `02 10` | Cargar llaves de trabajo (MK/SK, formato TR-31) |
| `09 22` | Cargar AID o llaves públicas CA (formato campo 62 de ISO 8583) |

### `02 A0`: solicitud (TLV: tag de 2 bytes, longitud de 1 byte)

| Tag | Valor usado por la app de ejemplo |
|---|---|
| `1F01` modo | `10` banda, `20` NFC, `40` chip, `70`/`71` todos |
| `1F04` llave | `sistema(01 DUKPT, 02 MK/SK, 03 fija) + índice` |
| `1F02` control | `10633630` |
| `1F03` fecha | `AAAAMMDDhhmmss` en BCD |
| `1F07` aleatorio | `313233` |
| `1F08` monto | Centavos en ASCII (máximo 12 caracteres) |
| `1F09` / `1F0A` | `33` / `3839` |

Mientras espera, el terminal envía avisos con el código `80` (recibido), `84` (chip insertado), `8A` (NFC detectado) y otros parecidos. La respuesta final con código `00` trae estos TLV:

| Tag | Contenido |
|---|---|
| `1F41` | Tipo de tarjeta y marca (01 UnionPay, 02 Visa, 03 Mastercard, 04 Discover, 05 Amex, 06 JCB) |
| `1F45` | TUSN |
| `1F46` | Resultado (1 = solicitar en línea) |
| `1F47` | PIN cifrado, si aplica |
| `1F48` | Datos de chip o NFC: `len(2) + lenSeq + seq + CVM(3) + len55(2) + campo 55` |
| `1F4C` | MAC |
| `1F4E` | Vencimiento |
| `1F4F` / `1F50` | Longitud cifrada y longitud original de cada pista |
| `1F52` / `1F53` | Número de secuencia del PAN / CVM |

## Llaves de depuración del SDK (solo pruebas)

El fabricante publica estas llaves en `M6Plus Debug Keys.txt`. Si su equipo salió de fábrica con llaves de prueba, su switch o HSM puede descifrar con ellas.

```
DUKPT índice 1   IPEK = 6AC292FAA1315B4D858AB3A3D7D5933A
                 KSN  = FFFF9876543210E00000
```

Si el KSN que devuelve el lector empieza con `FFFF9876543210`, el equipo tiene la llave de prueba estándar (BDK ANSI X9.24 `0123456789ABCDEFFEDCBA9876543210`). Si no, hay que inyectarle sus propias llaves de prueba con el comando `05 01` (sesión TLS) o pedírselo al fabricante.

## Flujo hacia el switch

1. `02 A0` con monto: el lector devuelve el campo 55 (ARQC), las pistas cifradas, el KSN y el PAN enmascarado.
2. La app arma un 0200 o 0100 ISO 8583 (DE 2/35 a partir de los datos descifrados en el switch, DE 55 = campo 55, DE 4 = monto).
3. El switch responde con DE 39 y, si aplica, DE 55 (ARPC y scripts).
4. `02 A1` con el DE 55 de la respuesta: el chip confirma (TC) o rechaza (en ese caso hay que hacer un reverso).
