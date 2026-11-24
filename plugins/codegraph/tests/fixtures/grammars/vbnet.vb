Imports System

Public Class Greeter
    Private ReadOnly _name As String

    Public Sub New(name As String)
        _name = name
    End Sub

    Public Function Greet() As String
        Return $"Hello, {_name}!"
    End Function

    Public Shared Sub Main()
        Console.WriteLine(New Greeter("world").Greet())
    End Sub
End Class
