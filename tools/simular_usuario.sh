#!/bin/sh
# Simula un usuario desplazándose por Bogotá (para probar la vista admin en vivo).
JAR=/tmp/sim_demo.jar
curl -s -c $JAR -X POST localhost:8791/api/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@colsanitas.com","pass":"demo123"}' > /dev/null

# recorrido: Chapinero -> norte por la Carrera 15 (ida y vuelta)
PUNTOS="4.6489,-74.0580 4.6531,-74.0562 4.6565,-74.0545 4.6610,-74.0552 4.6650,-74.0558 4.6684,-74.0559 4.6720,-74.0555 4.6760,-74.0540 4.6800,-74.0512 4.6760,-74.0540 4.6720,-74.0555 4.6684,-74.0559 4.6650,-74.0558 4.6610,-74.0552 4.6565,-74.0545"
for vuelta in 1 2 3 4 5 6; do
  for p in $PUNTOS; do
    LAT=${p%,*}; LNG=${p#*,}
    curl -s -b $JAR -X POST localhost:8791/api/location -H 'Content-Type: application/json' \
      -d "{\"lat\":$LAT,\"lng\":$LNG,\"label\":\"En movimiento por la Carrera 15 (demo)\"}" > /dev/null
    sleep 8
  done
done
