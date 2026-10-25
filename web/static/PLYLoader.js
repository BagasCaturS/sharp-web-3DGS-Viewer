/**
 * Bounds helper for SHARP Gaussian-splat PLY files.
 *
 * This module no longer renders anything - the actual Gaussian splatting is
 * handled by @mkkellogg/gaussian-splats-3d. It only parses the PLY header plus
 * the `x/y/z` vertex properties to compute a bounding box, which the frontend
 * uses to frame the camera.
 */

import * as THREE from 'three';

class SHARPPLYLoader {
    parseHeader(arrayBuffer) {
        const decoder = new TextDecoder('ascii');
        const headerBytes = new Uint8Array(arrayBuffer, 0, Math.min(16384, arrayBuffer.byteLength));
        const headerStr = decoder.decode(headerBytes);

        const endHeaderIdx = headerStr.indexOf('end_header');
        if (endHeaderIdx === -1) {
            throw new Error('end_header not found in PLY file');
        }

        // Advance to the end of the end_header line (handles \n and \r\n)
        let lineEnd = endHeaderIdx;
        while (lineEnd < headerStr.length && headerStr[lineEnd] !== '\n' && headerStr[lineEnd] !== '\r') {
            lineEnd++;
        }
        while (lineEnd < headerStr.length && (headerStr[lineEnd] === '\n' || headerStr[lineEnd] === '\r')) {
            lineEnd++;
        }
        const headerEnd = lineEnd;

        const lines = headerStr.substring(0, headerEnd).split('\n');
        let vertexCount = 0;
        const propertyNames = [];
        let format = 'binary_little_endian';
        let inVertexElement = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('format ')) {
                format = trimmed.split(' ')[1];
            } else if (trimmed.startsWith('element ')) {
                const parts = trimmed.split(' ');
                inVertexElement = parts.length >= 3 && parts[1] === 'vertex';
                if (inVertexElement) vertexCount = parseInt(parts[2], 10);
            } else if (trimmed.startsWith('property ') && inVertexElement) {
                const parts = trimmed.split(' ');
                if (parts.length >= 3) propertyNames.push(parts[2]);
            }
        }

        const propIndices = {};
        propertyNames.forEach((name, i) => { propIndices[name] = i; });

        for (const p of ['x', 'y', 'z']) {
            if (!(p in propIndices)) {
                throw new Error(`Missing required property: ${p}`);
            }
        }

        return {
            headerEnd,
            format,
            isLittleEndian: format === 'binary_little_endian',
            vertexCount,
            propIndices,
            vertexSize: propertyNames.length * 4,
        };
    }

    computeBounds(arrayBuffer) {
        const info = this.parseHeader(arrayBuffer);
        const { headerEnd, isLittleEndian, vertexCount, propIndices, vertexSize } = info;

        const available = arrayBuffer.byteLength - headerEnd;
        const dataView = new DataView(arrayBuffer, headerEnd);
        const ix = propIndices['x'] * 4;
        const iy = propIndices['y'] * 4;
        const iz = propIndices['z'] * 4;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < vertexCount; i++) {
            const off = i * vertexSize;
            if (off + vertexSize > available) break;

            const x = dataView.getFloat32(off + ix, isLittleEndian);
            const y = dataView.getFloat32(off + iy, isLittleEndian);
            const z = dataView.getFloat32(off + iz, isLittleEndian);

            if (x < minX) minX = x; else if (x > maxX) maxX = x;
            if (y < minY) minY = y; else if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; else if (z > maxZ) maxZ = z;
        }

        const center = new THREE.Vector3(
            (minX + maxX) / 2,
            (minY + maxY) / 2,
            (minZ + maxZ) / 2,
        );
        const dx = maxX - minX;
        const dy = maxY - minY;
        const dz = maxZ - minZ;
        const radius = Math.max(0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz), 0.001);

        return { center, radius, vertexCount };
    }
}

export { SHARPPLYLoader };
