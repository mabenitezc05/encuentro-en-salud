#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Convierte Prestadores.xlsx y Droguerias_con_coordenadas.xlsx en app/data/data.js
parseando los horarios en texto libre a rangos estructurados por día.

Estructura de schedule: dict con claves "0".."6" (lunes..domingo) y "H" (festivos).
Valor: [openMin, closeMin] en minutos desde medianoche, "24h", o None (cerrado/sin dato).
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import pandas as pd

BASE = Path(__file__).resolve().parent.parent

DAY_PATTERNS = [
    (r'lunes\s+a\s+viernes', [0, 1, 2, 3, 4]),
    (r'lunes\s+a\s+sabados?', [0, 1, 2, 3, 4, 5]),
    (r'lunes\s+a\s+domingos?', [0, 1, 2, 3, 4, 5, 6]),
    (r'domingo\s+a\s+domingo', [0, 1, 2, 3, 4, 5, 6, 'H']),
    (r'martes\s+a\s+sabados?', [1, 2, 3, 4, 5]),
    (r'lunes(?!\s+a\s)', [0]),
    (r'sabados?', [5]),
    (r'domingos?', [6]),
    (r'festivos?', ['H']),
]


def normalize(text):
    text = str(text)
    text = unicodedata.normalize('NFKC', text)
    text = text.replace('​', ' ')
    text = text.lower()
    # quitar tildes para simplificar regex
    text = ''.join(c for c in unicodedata.normalize('NFD', text)
                   if unicodedata.category(c) != 'Mn')
    # "a. m." / "a.m." / "a. m" -> "am"
    text = re.sub(r'\b([ap])\.?\s*m\b\.?', r'\1m', text)
    text = re.sub(r'\s+', ' ', text)
    text = text.replace('no festivo', '')  # "lunes no festivo" -> "lunes"
    return text


# hora con minutos (am/pm opcional) o sin minutos (am/pm obligatorio: "8 pm")
TIME_RE = re.compile(r'(\d{1,2}):\s*(\d{2})(?::\s*\d{2})?\s*(am|pm|m\b)?|(\d{1,2})\s*(am|pm)')


def parse_times(chunk):
    """Devuelve lista de minutos desde medianoche para cada hora encontrada."""
    out = []
    for m in TIME_RE.finditer(chunk):
        if m.group(4) is not None:
            h, mn, mer = int(m.group(4)), 0, m.group(5)
        else:
            h, mn, mer = int(m.group(1)), int(m.group(2)), m.group(3)
        if mer == 'pm' and h < 12:
            h += 12
        elif mer == 'am' and h == 12:
            h = 0
        elif mer == 'm':  # "12:30 m" = mediodía
            pass
        out.append(h * 60 + mn)
    return out


def chunk_info(chunk):
    """Clasifica un fragmento de texto de horario."""
    if '24 horas' in chunk or '24horas' in chunk:
        return '24h'
    if 'cerrado' in chunk:
        return 'closed'
    times = parse_times(chunk)
    if len(times) >= 2:
        # emparejar consecutivamente y tomar min apertura / max cierre
        opens, closes = [], []
        for i in range(0, len(times) - 1, 2):
            o, c = times[i], times[i + 1]
            if c <= o:  # cierre sin pm explícito: "7:00 a 6:00"
                c += 720
                if c <= o:
                    continue
            opens.append(o)
            closes.append(min(c, 1439))
        if opens:
            return [min(opens), max(closes)]
    return None


def parse_schedule(raw):
    """Parsea el texto libre a {day: range}. Une con min/max si hay varios rangos."""
    sched = {}
    text = normalize(raw)
    day_re = re.compile('|'.join('(?:%s)' % p for p, _ in DAY_PATTERNS))
    matches = list(day_re.finditer(text))
    pending_days = []
    for i, m in enumerate(matches):
        for pat, days in DAY_PATTERNS:
            if re.fullmatch(pat, m.group(0)):
                pending_days.extend(d for d in days if d not in pending_days)
                break
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end]
        # fragmento vacío tipo "sabados, domingos y festivos" -> agrupar con el siguiente
        stripped = re.sub(r'[\s,.;:y]+', '', chunk)
        info = chunk_info(chunk)
        if info is None and not stripped:
            continue  # los días quedan pendientes hasta hallar contenido
        if info is not None:
            for d in pending_days:
                k = str(d)
                prev = sched.get(k)
                if info == 'closed':
                    sched.setdefault(k, None)
                elif info == '24h':
                    sched[k] = '24h'
                elif prev is None or prev == 'closed' or not isinstance(prev, list):
                    if prev != '24h':
                        sched[k] = list(info)
                else:
                    sched[k] = [min(prev[0], info[0]), max(prev[1], info[1])]
        pending_days = []
    # fallback: texto sin días explícitos ("24 horas", "5:00 am a 9:00 pm")
    if not sched:
        info = chunk_info(text)
        if info == '24h':
            for d in ['0', '1', '2', '3', '4', '5', '6', 'H']:
                sched[d] = '24h'
        elif isinstance(info, list):
            for d in ['0', '1', '2', '3', '4', '5']:  # asumir lunes a sábado
                sched[d] = list(info)
    return sched


def categoria_prestador(nombre):
    n = normalize(nombre)
    if 'dental' in n:
        return 'Clínica Dental'
    if 'optico' in n:
        return 'Centro Óptico'
    if 'clinica' in n:
        return 'Clínica'
    if 'centro medico' in n:
        return 'Centro Médico'
    return 'Unidad Especializada'


def clean(s):
    if pd.isna(s):
        return ''
    return re.sub(r'\s+', ' ', str(s).replace('​', '')).strip()


def main():
    drog = pd.read_excel(BASE / 'Droguerias_con_coordenadas.xlsx')
    prest = pd.read_excel(BASE / 'Prestadores.xlsx')

    droguerias = []
    for _, r in drog.iterrows():
        raw = clean(r['HORARIO  ATENCIÓN'])
        droguerias.append({
            'id': 'D%s' % r['ID'],
            'tipo': 'drogueria',
            'nombre': clean(r['NOMBRE DE LA FARMACIA']),
            'direccion': clean(r['DIRECCIÓN ']),
            'lat': float(r['LATITUD']),
            'lng': float(r['LONGITUD']),
            'horarioRaw': raw,
            'schedule': parse_schedule(raw),
            'tipologia': clean(r['TIPOLOGIA(PROPIA/ALIADA)']),
            'canal': clean(r['Canal']),
            'refrigerados': clean(r['DISPENSACIÓN DE MEDICAMENTOS REFRIGERADOS (S/N)']),
            'controlEspecial': clean(r['DISPENSACIÓN DE MEDICAMENTOS DE CONTROL ESPECIAL (S/N)']),
            'altoCosto': clean(r['DISPENSACIÓN DE MEDICAMENTOS ALTO COSTO (S/N)']),
            'novedad': clean(r['NOVEDAD']),
        })

    prestadores = []
    for i, r in prest.iterrows():
        raw = clean(r['Horario'])
        nombre = clean(r['Centro médico'])
        prestadores.append({
            'id': 'P%d' % i,
            'tipo': 'prestador',
            'nombre': nombre,
            'categoria': categoria_prestador(nombre),
            'direccion': clean(r['Dirección']),
            'lat': float(r['Latitud']),
            'lng': float(r['Longitud']),
            'horarioRaw': raw,
            'schedule': parse_schedule(raw),
        })

    out = BASE / 'app' / 'data' / 'data.js'
    with open(out, 'w', encoding='utf-8') as f:
        f.write('// Generado por tools/build_data.py — no editar a mano\n')
        f.write('const DROGUERIAS = %s;\n' % json.dumps(droguerias, ensure_ascii=False, indent=1))
        f.write('const PRESTADORES = %s;\n' % json.dumps(prestadores, ensure_ascii=False, indent=1))
    print('OK ->', out)

    # resumen para verificación
    dias = ['L', 'M', 'X', 'J', 'V', 'S', 'D', 'H']
    keys = ['0', '1', '2', '3', '4', '5', '6', 'H']

    def fmt(s):
        parts = []
        for lbl, k in zip(dias, keys):
            v = s.get(k)
            if v == '24h':
                parts.append('%s:24h' % lbl)
            elif isinstance(v, list):
                parts.append('%s:%02d:%02d-%02d:%02d' % (lbl, v[0]//60, v[0]%60, v[1]//60, v[1]%60))
            elif k in s:
                parts.append('%s:cerr' % lbl)
        return ' '.join(parts) or 'SIN PARSEAR'

    for grupo in (droguerias, prestadores):
        for e in grupo:
            print('%-50s %s' % (e['nombre'][:50], fmt(e['schedule'])))


if __name__ == '__main__':
    sys.exit(main())
