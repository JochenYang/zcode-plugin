Imports System
Imports System.Collections.Generic
Imports System.IO
Imports IO = System.IO
Imports Microsoft.VisualBasic.Strings

Namespace Shop
    ''' <summary>Cart holding items.</summary>
    Partial Public Class Cart
        Implements ICloneable

        Private Shared ReadOnly Empty As New List(Of String)()
        Public Event Saved As EventHandler
        Public Property Items As List(Of String)
        Public ReadOnly Property Size As Integer
            Get
                Return If(Items Is Nothing, 0, Items.Count)
            End Get
        End Property

        Public Sub New()
            Me.New(0)
        End Sub

        Public Sub New(seed As Integer)
            Items = New List(Of String) From {seed.ToString()}
        End Sub

        Public Function Clone() As Object Implements ICloneable.Clone
            Dim copy As New Cart(1)
            Dim xs = New Integer() {1, 2}
            Dim ys(2) As Integer
            For Each x As Integer In xs
                If x > 0 AndAlso x <> 2 Then Continue For
            Next
            AddHandler Saved, Sub(sender As Object, e As EventArgs) copy.Size.ToString()
            RaiseEvent Saved(Me, EventArgs.Empty)
            Dim fx = Function(v As Integer) v * 2
            Return If(copy?.Items?.Count > 0, copy, Nothing)
        End Function

        Public Shared Operator +(a As Cart, b As Cart) As Cart
            Return a
        End Operator

        Protected Overrides Sub Finalize()
            MyBase.Finalize()
        End Sub
    End Class

    Public Delegate Function Predicate(Of T)(value As T) As Boolean

    Public Class Program
        Public Shared Sub Main(args As String())
            Dim c As Cart = New Cart(1)
            Dim n As Integer = CInt(Math.Sqrt(4.0))
            Dim s = Strings.Left("abc", n)
            System.Console.WriteLine(n & s & c.Size)
            Select Case n
                Case 1
                    Console.WriteLine("one")
                Case Else
                    Console.WriteLine("other")
            End Select
            Using r As New StreamReader("x")
                r.ReadToEnd()
            End Using
        End Sub
    End Class
End Namespace
