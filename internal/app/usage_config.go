package app

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

// ccusage silently ignores invalid config in some JSON-mode releases. Validate
// our explicit file against its pinned rules before allowing a report refresh.
// These are the schema keywords used by ccusage 20.0.26, not a general validator.
//
//go:embed ccusage_config_schema.json
var usageConfigSchemaJSON []byte

var usageConfigSchema = func() map[string]any {
	var schema map[string]any
	if err := json.Unmarshal(usageConfigSchemaJSON, &schema); err != nil {
		panic(err)
	}
	return schema
}()

func validateUsageConfig(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return fmt.Errorf("Invalid ccusage configuration %s: %w", path, err)
	}
	if err := checkUsageConfigRule(value, usageConfigSchema, "$", 0); err != nil {
		return fmt.Errorf("Invalid ccusage configuration %s: %w", path, err)
	}
	return nil
}

func checkUsageConfigRule(value any, rule map[string]any, location string, depth int) error {
	if depth > 64 {
		return fmt.Errorf("%s: configuration nesting is too deep", location)
	}
	if ref := stringValue(rule["$ref"]); ref != "" {
		rule = mapValue(mapValue(usageConfigSchema["definitions"])[strings.TrimPrefix(ref, "#/definitions/")])
	}
	typeName := stringValue(rule["type"])
	valid := false
	switch typeName {
	case "object":
		_, valid = value.(map[string]any)
	case "array":
		_, valid = value.([]any)
	case "string":
		_, valid = value.(string)
	case "boolean":
		_, valid = value.(bool)
	case "number", "integer":
		number, ok := value.(float64)
		valid = ok && (typeName == "number" || math.Trunc(number) == number)
	default:
		return fmt.Errorf("%s: unsupported pinned schema rule", location)
	}
	if !valid {
		return fmt.Errorf("%s: expected %s", location, typeName)
	}
	if choices, ok := rule["enum"].([]any); ok {
		found := false
		for _, choice := range choices {
			found = found || reflect.DeepEqual(value, choice)
		}
		if !found {
			return fmt.Errorf("%s: value is not one of the supported options", location)
		}
	}
	if minimum, ok := rule["minimum"].(float64); ok && value.(float64) < minimum {
		return fmt.Errorf("%s: must be at least %g", location, minimum)
	}
	if pattern := stringValue(rule["pattern"]); pattern != "" {
		matched, err := regexp.MatchString(pattern, value.(string))
		if err != nil || !matched {
			return fmt.Errorf("%s: value does not match the required format", location)
		}
	}
	if object, ok := value.(map[string]any); ok {
		for _, key := range stringsFromAny(rule["required"]) {
			if _, present := object[key]; !present {
				return fmt.Errorf("%s.%s: required property is missing", location, key)
			}
		}
		properties := mapValue(rule["properties"])
		keys := make([]string, 0, len(object))
		for key := range object {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			next, exists := properties[key]
			if !exists {
				if allowed, ok := rule["additionalProperties"].(bool); ok && !allowed {
					return fmt.Errorf("%s.%s: unsupported property", location, key)
				}
				next = rule["additionalProperties"]
			}
			if nextRule, ok := next.(map[string]any); ok {
				if err := checkUsageConfigRule(object[key], nextRule, location+"."+key, depth+1); err != nil {
					return err
				}
			}
		}
	}
	if array, ok := value.([]any); ok {
		for index, item := range array {
			if err := checkUsageConfigRule(item, mapValue(rule["items"]), fmt.Sprintf("%s[%d]", location, index), depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}
