#version 300 es
//
//  LiquidGlassFragment.metal
//  LiquidGlass
//
//  Created by Alexey Demin on 2025-12-05.
//  Ported to OpenGL ES 3.0 by Claude Sonnet 4.6 on 2026-03-13.
//

precision highp float;
precision highp int;

#define PI 3.14159265358979323846

// Refractive indices for chromatic dispersion (simulating glass-like prismatic effects)
const float refractiveIndexRed = 1.0 - 0.02;   // Red channel (slightly lower for dispersion)
const float refractiveIndexGreen = 1.0;        // Green channel (neutral)
const float refractiveIndexBlue = 1.0 + 0.02;  // Blue channel (slightly higher for dispersion)

// Maximum number of rectangles (must match JS side)
const int maxRectangles = 16;

// Uniforms: Individual uniforms for WebGL buffer binding
uniform vec2 resolution;               // Viewport resolution (pixels)
uniform float contentsScale;           // Scale factor for resolution independence
uniform vec2 touchPoint;               // Touch position in points (upper-left origin)
uniform float shapeMergeSmoothness;    // Smooth min blend factor (higher = softer morph)
uniform float cornerRadius;            // Rounding radius for rectangle corners
uniform float cornerRoundnessExponent; // Superellipse exponent for corner sharpness (higher = sharper)
uniform vec4 materialTint;             // RGBA tint for glass color
uniform float glassThickness;          // Simulated thickness (pixels) for refraction depth
uniform float refractiveIndex;         // Base refractive index of glass
uniform float dispersionStrength;      // Chromatic aberration intensity
uniform float fresnelDistanceRange;    // Edge distance over which Fresnel builds
uniform float fresnelIntensity;        // Overall Fresnel reflection strength
uniform float fresnelEdgeSharpness;    // Power for Fresnel falloff hardness
uniform float glareDistanceRange;      // Edge distance for glare highlights
uniform float glareAngleConvergence;   // Angle-based glare focusing
uniform float glareOppositeSideBias;   // Multiplier for glare on far side of normal
uniform float glareIntensity;          // Overall glare highlight strength
uniform float glareEdgeSharpness;      // Power for glare falloff hardness
uniform float glareDirectionOffset;    // Angular offset for glare direction
uniform int rectangleCount;            // Number of active rectangles
uniform vec4 rectangles[16];           // Array of rectangles (x, y, width, height) in points, upper-left origin

uniform sampler2D background;

in vec2 v_uv;
out vec4 fragColor;

// =============================================================================
// Signed Distance Field (SDF) Primitives and Operations
// SDFs return signed distance: >0 outside, <0 inside, 0 on surface.
// =============================================================================

// Circle SDF: Distance from center minus radius
float circleSDF(vec2 point, float radius) {
    return length(point) - radius;
}

// Superellipse SDF: Generalized superellipse for organic shapes.
// Returns vec3: x=distance, yz=gradient for normals.
// Uses segment approximation (24 steps) for boundary evaluation.
vec3 superellipseSDF(vec2 point, float scale, float exponent) {
    point /= scale;
    vec2 signedPoint = sign(point);
    vec2 absPoint = abs(point);
    float sumPowers = pow(absPoint.x, exponent) + pow(absPoint.y, exponent);
    vec2 gradient = signedPoint * pow(absPoint, vec2(exponent - 1.0)) * pow(sumPowers, 1.0 / exponent - 1.0);

    // Skip the loop entirely
//    float distance = pow(sumPowers, 1.0 / exponent) - 1.0;
//    return vec3(distance * scale, gradient);

    // Abs and swap for quadrant handling
    point = abs(point);
    if (point.y > point.x) {
        point = point.yx;
    }
    exponent = 2.0 / exponent;
    float sideSign = 1.0;
    float minDistanceSquared = 1e20;
    const int segmentCount = 24;
    vec2 previousQuadrantPoint = vec2(1.0, 0.0);
    for (int i = 1; i < segmentCount; ++i) {
        float segmentParam = float(i) / float(segmentCount - 1);
        vec2 quadrantPoint = vec2(
            pow(cos(segmentParam * PI / 4.0), exponent),
            pow(sin(segmentParam * PI / 4.0), exponent)
        );
        vec2 pointA = point - previousQuadrantPoint;
        vec2 pointB = quadrantPoint - previousQuadrantPoint;
        vec2 perpendicular = pointA - pointB * clamp(dot(pointA, pointB) / dot(pointB, pointB), 0.0, 1.0);
        float distSq = dot(perpendicular, perpendicular);
        if (distSq < minDistanceSquared) {
            minDistanceSquared = distSq;
            sideSign = pointA.x * pointB.y - pointA.y * pointB.x;
        }
        previousQuadrantPoint = quadrantPoint;
    }
    return vec3(sqrt(minDistanceSquared) * sign(sideSign) * scale, gradient);
}

// Superellipse corner SDF: For smooth, parametric rounding in rectangles.
float superellipseCornerSDF(vec2 point, float radius, float exponent) {
    point = abs(point);
    float value = pow(pow(point.x, exponent) + pow(point.y, exponent), 1.0 / exponent);
    return value - radius;
}

// Rounded rectangle SDF: Box with superellipse corners for customizable rounding.
// rect: vec4(x, y, width, height) in points, upper-left origin
// fragmentCoord: pixel coordinates (upper-left origin)
float roundedRectangleSDF(vec2 fragmentCoord, vec4 rect, float cornerRadius, float roundnessExponent) {
    // Convert rectangle from points to pixels
    vec2 rectOriginPx = rect.xy * contentsScale;
    vec2 rectSizePx = rect.zw * contentsScale;
    float scaledCornerRadius = cornerRadius * contentsScale;

    // Calculate rectangle center in pixels
    vec2 rectCenterPx = rectOriginPx + rectSizePx * 0.5;

    // Translate fragment to rectangle-centered coordinates
    vec2 point = fragmentCoord - rectCenterPx;

    // Distance to unrounded box half-extents
    vec2 halfExtents = rectSizePx * 0.5;
    vec2 edgeDistance = abs(point) - halfExtents;

    float surfaceDistance;

    if (edgeDistance.x > -scaledCornerRadius && edgeDistance.y > -scaledCornerRadius) {
        // Corner region: Apply superellipse rounding
        vec2 cornerCenter = sign(point) * (halfExtents - vec2(scaledCornerRadius));
        vec2 cornerRelativePoint = point - cornerCenter;
        surfaceDistance = superellipseCornerSDF(cornerRelativePoint, scaledCornerRadius, roundnessExponent);
    } else {
        // Straight edges or interior: Standard rounded box formula
        surfaceDistance = min(max(edgeDistance.x, edgeDistance.y), 0.0) + length(max(edgeDistance, 0.0));
    }

    return surfaceDistance;
}

// Smooth union: Blends two SDFs with polynomial smoothing to avoid sharp seams during morphing.
float smoothUnion(float distanceA, float distanceB, float smoothness) {
    float hermite = clamp(0.5 + 0.5 * (distanceB - distanceA) / smoothness, 0.0, 1.0);
    return mix(distanceB, distanceA, hermite) - smoothness * hermite * (1.0 - hermite);
}

// Primary SDF: Merges all rectangles in the array using smooth union.
// fragmentCoord: pixel coordinates (upper-left origin)
float primaryShapeSDF(vec2 fragmentCoord) {
    // Start with a large distance (outside all shapes)
    float combinedDistance = 1e10;

    // Iterate over all active rectangles and compute smooth union
    for (int i = 0; i < rectangleCount && i < maxRectangles; ++i) {
        vec4 rect = rectangles[i];

        // Skip empty rectangles
        if (rect.z <= 0.0 || rect.w <= 0.0) continue;

        float rectDistance = roundedRectangleSDF(
            fragmentCoord,
            rect,
            cornerRadius,
            cornerRoundnessExponent
        );

        // Normalize distance to resolution for consistent smooth union
        float normalizedRectDist = rectDistance / resolution.y;

        if (i == 0) {
            combinedDistance = normalizedRectDist;
        } else {
            combinedDistance = smoothUnion(combinedDistance, normalizedRectDist, shapeMergeSmoothness);
        }
    }

    return combinedDistance;
}

// =============================================================================
// Surface Normal Computation
// Gradients of SDF provide view-space normals for refraction and lighting.
// =============================================================================

// Adaptive finite-difference normal: Uses screen derivatives for epsilon (scale-aware).
// Raw gradient used (not normalized) in some steps for magnitude encoding.
vec2 computeSurfaceNormal(vec2 fragmentCoord) {
    // Adaptive epsilon from pixel derivatives (fallback to min for stability)
    vec2 epsilon = vec2(
        max(abs(dFdx(fragmentCoord.x)), 0.0001),
        max(abs(dFdy(fragmentCoord.y)), 0.0001)
    );

    vec2 gradient = vec2(
        primaryShapeSDF(fragmentCoord + vec2(epsilon.x, 0.0)) -
        primaryShapeSDF(fragmentCoord - vec2(epsilon.x, 0.0)),
        primaryShapeSDF(fragmentCoord + vec2(0.0, epsilon.y)) -
        primaryShapeSDF(fragmentCoord - vec2(0.0, epsilon.y))
    ) / (2.0 * epsilon);

    // normalize(gradient);  // Commented: Raw gradient preferred for debug magnitude; normalized for effects
    return gradient * 1.414213562 * 1000.0;  // Scaled for visualization
}

// Isotropic four-sample normal (diagonal finite differences for less bias).
vec2 computeIsotropicNormal(vec2 fragmentCoord) {
    float epsilon = 0.7071 * 0.0005;  // Diagonal step size
    vec2 offset1 = vec2(1.0, 1.0);
    vec2 offset2 = vec2(-1.0, 1.0);
    vec2 offset3 = vec2(1.0, -1.0);
    vec2 offset4 = vec2(-1.0, -1.0);

    return normalize(
        offset1 * primaryShapeSDF(fragmentCoord + epsilon * offset1) +
        offset2 * primaryShapeSDF(fragmentCoord + epsilon * offset2) +
        offset3 * primaryShapeSDF(fragmentCoord + epsilon * offset3) +
        offset4 * primaryShapeSDF(fragmentCoord + epsilon * offset4)
    );
}

// Basic central-difference normal (simple axis-aligned).
vec2 computeCentralNormal(vec2 fragmentCoord) {
    float epsilon = 0.0005;
    vec2 offset = vec2(epsilon, 0.0);

    float dx = primaryShapeSDF(fragmentCoord + offset.xy) -
               primaryShapeSDF(fragmentCoord - offset.xy);
    float dy = primaryShapeSDF(fragmentCoord + offset.yx) -
               primaryShapeSDF(fragmentCoord - offset.yx);

    return normalize(vec2(dx, dy));
}

// =============================================================================
// Color Space Utilities (Perceptual Adjustments via LCH)
// For tinting highlights without desaturation; based on CIE LAB/LCH conversions.
// Half for colors; float for matrices to preserve precision.
// =============================================================================

// D65 white point (sRGB standard)
const vec3 d65WhitePoint = vec3(0.95045592705, 1.0, 1.08905775076);
//const vec3 d50WhitePoint = vec3(0.96429567643, 1.0, 0.82510460251);
const vec3 whiteReference = d65WhitePoint;

// sRGB to XYZ matrix
const mat3 rgbToXyzMatrix = mat3(
    vec3(0.4124, 0.3576, 0.1805),
    vec3(0.2126, 0.7152, 0.0722),
    vec3(0.0193, 0.1192, 0.9505)
);

// XYZ (D65) to XYZ (D50) adaptation
const mat3 xyzD65ToD50Matrix = mat3(
    vec3(1.0479298208405488,  0.022946793341019088, -0.05019222954313557),
    vec3(0.029627815688159344,  0.990434484573249  , -0.01707382502938514),
    vec3(-0.009243058152591178,  0.015055144896577895,  0.7518742899580008)
);

// XYZ to linear RGB matrix
const mat3 xyzToRgbMatrix = mat3(
    vec3( 3.2406255, -1.537208 , -0.4986286),
    vec3(-0.9689307,  1.8757561,  0.0415175),
    vec3( 0.0557101, -0.2040211,  1.0569959)
);

// XYZ (D50) to XYZ (D65) adaptation
const mat3 xyzD50ToD65Matrix = mat3(
    vec3(0.9554734527042182  , -0.023098536874261423,  0.0632593086610217  ),
    vec3(-0.028369706963208136,  1.0099954580058226  ,  0.021041398966943008),
    vec3( 0.012314001688319899, -0.020507696433477912,  1.3303659366080753 )
);

// sRGB uncompanding (gamma to linear)
float linearizeSRGB(float channel) {
    return channel > 0.04045 ? pow((channel + 0.055) / 1.055, 2.4) : channel / 12.92;
}

// Linear to sRGB companding (apply gamma)
float gammaCorrectSRGB(float linear) {
    return linear <= 0.0031308 ? 12.92 * linear : 1.055 * pow(linear, 0.41666666666) - 0.055;
}

// Linear RGB to XYZ
vec3 linearRgbToXyz(vec3 linearRgb) {
    return (whiteReference.x == d65WhitePoint.x) ? linearRgb * rgbToXyzMatrix : linearRgb * rgbToXyzMatrix * xyzD65ToD50Matrix;
}

// sRGB to linear RGB
vec3 srgbToLinear(vec3 srgb) {
    return vec3(linearizeSRGB(srgb.x), linearizeSRGB(srgb.y), linearizeSRGB(srgb.z));
}

// Linear RGB to sRGB
vec3 linearToSrgb(vec3 linear) {
    return vec3(gammaCorrectSRGB(linear.x), gammaCorrectSRGB(linear.y), gammaCorrectSRGB(linear.z));
}

// sRGB to XYZ
vec3 srgbToXyz(vec3 srgb) {
    return linearRgbToXyz(vec3(srgbToLinear(srgb)));
}

// XYZ to LAB non-linear transform
float xyzToLabNonlinear(float normalizedX) {
    // Threshold: (24/116)^3 ≈ 0.00885645167
    return normalizedX > 0.00885645167 ? pow(normalizedX, 1.0 / 3.0) : 7.78703703704 * normalizedX + 0.13793103448;
}

// XYZ to CIE LAB (perceptual uniform space)
vec3 xyzToLab(vec3 xyz) {
    vec3 scaledXyz = xyz / whiteReference;
    scaledXyz = vec3(
        xyzToLabNonlinear(scaledXyz.x),
        xyzToLabNonlinear(scaledXyz.y),
        xyzToLabNonlinear(scaledXyz.z)
    );
    return vec3(
        116.0 * scaledXyz.y - 16.0,  // Lightness (L)
        500.0 * (scaledXyz.x - scaledXyz.y),  // a* (green-red)
        200.0 * (scaledXyz.y - scaledXyz.z)   // b* (blue-yellow)
    );
}

// sRGB to LAB
vec3 srgbToLab(vec3 srgb) {
    return xyzToLab(srgbToXyz(srgb));
}

// LAB to LCH (cylindrical: Lightness, Chroma, Hue in degrees)
vec3 labToLch(vec3 lab) {
    float chroma = sqrt(dot(lab.yz, lab.yz));
    float hueDegrees = atan(lab.z, lab.y) * (180.0 / PI);
    return vec3(lab.x, chroma, hueDegrees);
}

// sRGB to LCH
vec3 srgbToLch(vec3 srgb) {
    return labToLch(srgbToLab(srgb));
}

// XYZ to linear RGB
vec3 xyzToLinearRgb(vec3 xyz) {
    return (whiteReference.x == d65WhitePoint.x) ? xyz * xyzToRgbMatrix : xyz * xyzD50ToD65Matrix * xyzToRgbMatrix;
}

// XYZ to sRGB
vec3 xyzToSrgb(vec3 xyz) {
    return linearToSrgb(vec3(xyzToLinearRgb(xyz)));
}

// LAB to XYZ inverse non-linear
float labToXyzNonlinear(float transformed) {
    // Threshold: 6/29 ≈ 0.206897
    return transformed > 0.206897 ? transformed * transformed * transformed : 0.12841854934 * (transformed - 0.137931034);
}

// LAB to XYZ
vec3 labToXyz(vec3 lab) {
    float whiteScaled = (lab.x + 16.0) / 116.0;
    return whiteReference * vec3(
        labToXyzNonlinear(whiteScaled + lab.y / 500.0),
        labToXyzNonlinear(whiteScaled),
        labToXyzNonlinear(whiteScaled - lab.z / 200.0)
    );
}

// LAB to sRGB
vec3 labToSrgb(vec3 lab) {
    return xyzToSrgb(labToXyz(lab));
}

// LCH to LAB
vec3 lchToLab(vec3 lch) {
    float hueRadians = lch.z * (PI / 180.0);
    return vec3(lch.x, lch.y * cos(hueRadians), lch.y * sin(hueRadians));
}

// LCH to sRGB
vec3 lchToSrgb(vec3 lch) {
    return labToSrgb(lchToLab(lch));
}

// HSV to RGB (for normal rainbow visualization)
vec3 hsvToRgb(vec3 hsv) {
    vec4 k = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(hsv.xxx + k.xyz) * 6.0 - k.www);
    return hsv.z * mix(k.xxx, clamp(p - k.xxx, 0.0, 1.0), hsv.y);
}

// Vector to angle [0, 2π]
float vectorToAngle(vec2 vector) {
    float angle = atan(vector.y, vector.x);
    return (angle < 0.0) ? angle + 2.0 * PI : angle;
}

// Normalized vector to rainbow color (HSV hue from angle)
vec3 vectorToRainbowColor(vec2 vector) {
    float angle = vectorToAngle(vector);
    float hue = float(angle / (2.0 * PI));
    vec3 hsv = vec3(hue, 1.0, 1.0);
    return hsvToRgb(hsv);
}

// Texture sample with per-channel dispersion offset (simulates prism fringing).
// Samples R/G/B separately with refractive index-based UV shifts.
vec4 sampleWithDispersion(sampler2D tex, vec2 baseUv, vec2 offset, float dispersionFactor) {
    vec4 color = vec4(1.0);
    // Red: Minimal shift (lower index)
    color.r = texture(tex, baseUv + offset * (1.0 - (refractiveIndexRed - 1.0) * dispersionFactor)).r;
    // Green: Neutral
    color.g = texture(tex, baseUv + offset * (1.0 - (refractiveIndexGreen - 1.0) * dispersionFactor)).g;
    // Blue: Maximal shift (higher index)
    color.b = texture(tex, baseUv + offset * (1.0 - (refractiveIndexBlue - 1.0) * dispersionFactor)).b;
    return color;
}

// =============================================================================
// Fragment Shader: Full Progressive Effect Pipeline
// =============================================================================
void main() {

    // Logical resolution (scale-normalized)
    vec2 logicalResolution = resolution / contentsScale;

    // Fragment coordinate in pixels (from UV, upper-left origin)
    vec2 fragmentPixelCoord = vec2(v_uv) * resolution;

    // Primary merged SDF distance (normalized to resolution.y)
    float shapeDistance = primaryShapeSDF(fragmentPixelCoord);

    vec4 outputColor;

    // Pixel size for anti-aliasing (y-dominant for aspect)
//    float pixelSize = 2.0 / resolution.y;

    // Slightly expanded threshold for smoother AA
    if (shapeDistance < 0.005) {
        float normalizedDepth = -shapeDistance * logicalResolution.y;

        // Refraction shift factor
        float depthRatio = 1.0 - normalizedDepth / glassThickness;
        float incidentAngle = asin(pow(depthRatio, 2.0));
        float transmittedAngle = asin(1.0 / refractiveIndex * sin(incidentAngle));
        float edgeShiftFactor = -tan(transmittedAngle - incidentAngle);
        if (normalizedDepth >= glassThickness) {
            edgeShiftFactor = 0.0;
        }

        if (edgeShiftFactor <= 0.0) {
            outputColor = texture(background, vec2(v_uv));
            outputColor = mix(outputColor, vec4(vec3(materialTint.rgb), 1.0), materialTint.a * 0.8);
        } else {
            vec2 surfaceNormal = computeSurfaceNormal(fragmentPixelCoord);
            // Dispersion-sampled refraction (scale/aspect corrected)
            vec2 offsetUv = vec2(-surfaceNormal * edgeShiftFactor * 0.05 * contentsScale * vec2(
                resolution.y / (logicalResolution.x * contentsScale),
                1.0
            ));
            vec4 refractedWithDispersion = sampleWithDispersion(background, vec2(v_uv), vec2(offsetUv), dispersionStrength);

            // Base material tint
            outputColor = mix(refractedWithDispersion, vec4(vec3(materialTint.rgb), 1.0), materialTint.a * 0.8);

            // Fresnel: LCH-lightness boosted reflection
            float fresnelValue = clamp(
                pow(
                    1.0 + shapeDistance * logicalResolution.y / 1500.0 * pow(500.0 / fresnelDistanceRange, 2.0) + fresnelEdgeSharpness,
                    5.0
                ),
                0.0, 1.0
            );

            vec3 fresnelBaseTint = mix(vec3(1.0), vec3(materialTint.rgb), materialTint.a * 0.5);
            vec3 fresnelLch = srgbToLch(fresnelBaseTint);
            fresnelLch.x += 20.0 * fresnelValue * fresnelIntensity;
            fresnelLch.x = clamp(fresnelLch.x, 0.0, 100.0);

            outputColor = mix(
                outputColor,
                vec4(lchToSrgb(fresnelLch), 1.0),
                fresnelValue * fresnelIntensity * 0.7 * length(surfaceNormal)
            );

            // Glare: Directional, LCH-boosted (lightness + chroma)
            float glareGeometryValue = clamp(
                pow(
                    1.0 + shapeDistance * logicalResolution.y / 1500.0 * pow(500.0 / glareDistanceRange, 2.0) + glareEdgeSharpness,
                    5.0
                ),
                0.0, 1.0
            );

            float glareAngle = (vectorToAngle(normalize(surfaceNormal)) - PI / 4.0 + glareDirectionOffset) * 2.0;
            int isFarSide = 0;
            if ((glareAngle > PI * (2.0 - 0.5) && glareAngle < PI * (4.0 - 0.5)) || glareAngle < PI * (0.0 - 0.5)) {
                isFarSide = 1;
            }
            float angularGlare = (0.5 + sin(glareAngle) * 0.5) *
                                 (isFarSide == 1 ? 1.2 * glareOppositeSideBias : 1.2) *
                                 glareIntensity;
            angularGlare = clamp(pow(angularGlare, 0.1 + glareAngleConvergence * 2.0), 0.0, 1.0);

            vec3 baseGlare = mix(refractedWithDispersion.rgb, vec3(materialTint.rgb), materialTint.a * 0.5);
            vec3 glareLch = srgbToLch(baseGlare);
            glareLch.x += 150.0 * angularGlare * glareGeometryValue;
            glareLch.y += 30.0 * angularGlare * glareGeometryValue;
            glareLch.x = clamp(glareLch.x, 0.0, 120.0);

            outputColor = mix(
                outputColor,
                vec4(lchToSrgb(glareLch), 1.0),
                angularGlare * glareGeometryValue * length(surfaceNormal)
            );
        }
    } else {
        outputColor = vec4(0.0);//texture(background, vec2(v_uv));
    }

    // Boundary anti-aliasing (smoothstep blend)
    outputColor = mix(outputColor, vec4(0.0), smoothstep(-0.01, 0.005, shapeDistance));

    fragColor = outputColor;
}
