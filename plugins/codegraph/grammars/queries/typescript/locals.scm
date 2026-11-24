; Scope-level locals for the TypeScript grammar (tree-sitter-wasms 0.1.13, ABI 14).
; Maintained with the plugin: the upstream queries/locals.scm only tags parameter
; names, with no @local.scope / @local.reference, so nothing can be resolved.
; Consumed by src/resolve/locals.mjs (CONTRACTS.md §6/§8).

; Scopes
;-------

[
  (program)
  (statement_block)
  (function_declaration)
  (generator_function_declaration)
  (function_expression)
  (generator_function)
  (arrow_function)
  (method_definition)
  (class_declaration)
  (abstract_class_declaration)
  (class)
  (interface_declaration)
  (type_alias_declaration)
  (enum_declaration)
  (module)
  (internal_module)
  (switch_body)
  (for_statement)
  (for_in_statement)
  (catch_clause)
] @local.scope

; Definitions
;------------

; Declarations bind their name in the enclosing scope (these are indexed symbols).
(function_declaration name: (identifier) @local.definition)
(generator_function_declaration name: (identifier) @local.definition)
(class_declaration name: (type_identifier) @local.definition)
(abstract_class_declaration name: (type_identifier) @local.definition)
(interface_declaration name: (type_identifier) @local.definition)
(type_alias_declaration name: (type_identifier) @local.definition)
(enum_declaration name: (identifier) @local.definition)
(module name: (identifier) @local.definition)
(type_parameter name: (type_identifier) @local.definition)

; Variables, parameters and loop / catch bindings (locals, normally not indexed).
(variable_declarator name: (identifier) @local.definition)
(required_parameter pattern: (identifier) @local.definition)
(optional_parameter pattern: (identifier) @local.definition)
(for_in_statement left: (identifier) @local.definition)
(catch_clause parameter: (identifier) @local.definition)
(assignment_pattern left: (identifier) @local.definition)

; Destructuring patterns.
(object_pattern (shorthand_property_identifier_pattern) @local.definition)
(pair_pattern value: (identifier) @local.definition)
(object_assignment_pattern left: (shorthand_property_identifier_pattern) @local.definition)
(array_pattern (identifier) @local.definition)
(rest_pattern (identifier) @local.definition)

; References
;------------

(identifier) @local.reference
(type_identifier) @local.reference
(shorthand_property_identifier) @local.reference
