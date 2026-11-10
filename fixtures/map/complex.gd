@tool
class_name Workshop
extends Node
signal prepared(room: Node)
@export_group("Layout")
var private_size := 12
@export_range(1, 5)
var seats := 3
const ROOM = preload("res://room.tscn")
# static func false_method(): add_child(Imposter.new())
const NOTES := """
func quoted_method():
	add_child(Imaginary.new())
"""

class Builder:
	extends RefCounted
	static func make(
		scene: PackedScene,
		label: String = "not: the end" # ) and another fake token
	) -> Node:
		var callback := func():
			var node = Node.new()
			return node
		var node = scene.instantiate()
		node.add_child(callback.call())
		return node

func begin() -> void:
	var room = Builder.make(
		load("res://room.tscn")
	)
	add_child(room)
