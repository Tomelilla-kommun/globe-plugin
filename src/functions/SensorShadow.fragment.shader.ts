export default `
precision highp float;

#define USE_NORMAL_SHADING

uniform float view_distance;               // max view distance (meters)
uniform vec3 viewArea_color;
uniform vec3 shadowArea_color;
uniform float percentShade;                // green alpha
uniform float shadowAlpha;                 // max red alpha
uniform float shadowDepthStart;            // meters (start of red fade)
uniform float shadowDepthEnd;              // meters (end of red fade)
uniform sampler2D colorTexture;
uniform sampler2D shadowMap;
uniform sampler2D depthTexture;
uniform mat4 shadowMap_matrix;
uniform vec4 shadowMap_camera_positionEC;  // light position in eye coords
uniform vec3 ellipsoidInverseRadii;
uniform bool exclude_terrain;
uniform vec4 shadowMap_texelSizeDepthBiasAndNormalShadingSmooth;
uniform vec4 shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness;

in vec2 v_textureCoordinates;
out vec4 FragColor;

vec4 toEye(in vec2 uv, in float depth){
    vec4 p = czm_inverseProjection * vec4(uv * 2.0 - 1.0, depth, 1.0);
    return p / p.w;
}

float getDepth(in vec4 depth){
    float z = czm_unpackDepth(depth);
    z = czm_reverseLogDepth(z);
    return (2.0 * z - czm_depthRange.near - czm_depthRange.far) / (czm_depthRange.far - czm_depthRange.near);
}

void main() {
    vec4 color = texture(colorTexture, v_textureCoordinates);
    float screenDepth = getDepth(texture(depthTexture, v_textureCoordinates));

    // skip sky/far
    if (screenDepth >= 1.0) {
        FragColor = color;
        return;
    }

    vec4 positionEC = toEye(v_textureCoordinates, screenDepth);

    if (exclude_terrain && czm_ellipsoidContainsPoint(ellipsoidInverseRadii, positionEC.xyz)) {
        FragColor = color;
        return;
    }

    // shadow parameters - increased bias to reduce flickering on slopes
    czm_shadowParameters shadowParams;
    shadowParams.texelStepSize = shadowMap_texelSizeDepthBiasAndNormalShadingSmooth.xy;
    shadowParams.depthBias = shadowMap_texelSizeDepthBiasAndNormalShadingSmooth.z * max(screenDepth * 0.02, 2.0);
    shadowParams.normalShadingSmooth = shadowMap_texelSizeDepthBiasAndNormalShadingSmooth.w;
    shadowParams.darkness = shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness.w;

    // shadow-map coords
    vec4 shadowPos = shadowMap_matrix * positionEC;
    shadowPos /= shadowPos.w;
    if (any(lessThan(shadowPos.xyz, vec3(0.0))) || any(greaterThan(shadowPos.xyz, vec3(1.0)))) {
        FragColor = color;
        return;
    }

    // compute light and world positions (in world space)
    vec4 lightWC = czm_inverseView * vec4(shadowMap_camera_positionEC.xyz, 1.0); // light pos (world)
    vec4 fragWC  = czm_inverseView * vec4(positionEC.xyz, 1.0);                   // frag pos (world)

    // early distance culling
    float d2 = dot(lightWC.xyz - fragWC.xyz, lightWC.xyz - fragWC.xyz);
    if (d2 > view_distance * view_distance) {
        FragColor = color;
        return;
    }

    shadowParams.texCoords = shadowPos.xy;
    shadowParams.depth = shadowPos.z;
    shadowParams.nDotL = 1.0;

    float u = smoothstep(0.0, 0.02, shadowPos.x) * smoothstep(1.0, 0.98, 1.0 - shadowPos.x);
    float v = smoothstep(0.0, 0.02, shadowPos.y) * smoothstep(1.0, 0.98, 1.0 - shadowPos.y);
    float edgeFade = min(u, v);

    float visibility = czm_shadowVisibility(shadowMap, shadowParams);

    // Smooth blending between visible (green) and shadow (red) to reduce flicker
    // Map visibility [0.3, 0.8] to shadow factor [1, 0] with smooth transition
    float shadowFactor = 1.0 - smoothstep(0.3, 0.8, visibility);

    // SHADOW distance-based fade
    float distFromView = length(fragWC.xyz - lightWC.xyz);

    float start = shadowDepthStart;
    float end = shadowDepthEnd;
    if (end <= start + 1e-6) {
        start = 0.0;
        end = view_distance;
    }

    float t = clamp((start - distFromView) / (start - end), 0.5, 1.0);
    float distFade = smoothstep(0.0, 1.0, t);

    // Blend green and red based on visibility (soft transition instead of hard cutoff)
    float greenAlpha = percentShade * edgeFade * (1.0 - shadowFactor);
    float redAlpha = shadowAlpha * distFade * edgeFade * shadowFactor;

    // Composite: apply green tint, then red tint
    vec3 tinted = mix(color.rgb, viewArea_color, greenAlpha);
    tinted = mix(tinted, shadowArea_color, redAlpha);

    FragColor = vec4(tinted, color.a);
}
`;
